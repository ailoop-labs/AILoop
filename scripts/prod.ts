#!/usr/bin/env bun
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, resolveConfigDbPath } from "../src/config/env";
import { startConsoleServer } from "../src/server";
import { DatabaseManager } from "../src/utils/db";
import { isPidAlive, spawnDetachedProcess, stopProcess, waitForHttpHealth } from "../src/scripts/prod-runtime";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const RUN_DIR = path.join(ROOT_DIR, ".ailoop");
const PID_FILE = path.join(RUN_DIR, "prod.server.pid");
const LOG_FILE = path.join(RUN_DIR, "prod.server.log");
const TOKEN_CACHE_FILE = path.join(RUN_DIR, "console.admin.token.cache");
const START_LOCK_DIR = path.join(RUN_DIR, "prod.server.start.lock");
const STOP_TIMEOUT_MS = readDurationEnv("AILOOP_PROD_STOP_TIMEOUT_SECONDS", 20_000);
const START_LOCK_WAIT_MS = readDurationEnv("AILOOP_PROD_START_LOCK_WAIT_SECONDS", 30_000);
const STARTUP_TIMEOUT_MS = readDurationEnv("AILOOP_PROD_STARTUP_TIMEOUT_SECONDS", 20_000);
const BUN_BIN = Bun.which("bun");

function readDurationEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallbackMs;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return Math.round(parsed * 1000);
}

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseUtcDate(value: string): number | null {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function ageInDays(todayUtc: string, issuedUtc: string): number {
  const todayMs = parseUtcDate(todayUtc);
  const issuedMs = parseUtcDate(issuedUtc);
  if (todayMs === null || issuedMs === null) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Math.floor((todayMs - issuedMs) / 86_400_000);
}

function expiryDate(issuedUtc: string): string | null {
  const issuedMs = parseUtcDate(issuedUtc);
  if (issuedMs === null) {
    return null;
  }

  const date = new Date(issuedMs);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

async function writePidFile(pid: number): Promise<void> {
  await fs.writeFile(PID_FILE, `${pid}\n`, "utf8");
}

async function readPidFile(): Promise<number | null> {
  try {
    const raw = (await fs.readFile(PID_FILE, "utf8")).trim();
    if (!raw) {
      return null;
    }

    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function clearLoopFlags(): Promise<void> {
  await Promise.all([
    fs.rm(path.join(RUN_DIR, "loop.lock"), { force: true }),
    fs.rm(path.join(RUN_DIR, "loop.pid"), { force: true }),
    fs.rm(path.join(RUN_DIR, "loop.pause"), { force: true }),
    fs.rm(path.join(RUN_DIR, "loop.stop"), { force: true })
  ]);
}

async function ensureDependenciesInstalled(): Promise<void> {
  if (!existsSync(path.join(ROOT_DIR, "node_modules"))) {
    runCommand(BUN_BIN!, ["install"]);
  }

  if (!existsSync(path.join(ROOT_DIR, "web", "node_modules"))) {
    runCommand(BUN_BIN!, ["--cwd=web", "install"]);
  }
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }
}

async function acquireStartLock(): Promise<() => Promise<void>> {
  await fs.mkdir(RUN_DIR, { recursive: true });
  const deadline = Date.now() + START_LOCK_WAIT_MS;

  while (true) {
    try {
      await fs.mkdir(START_LOCK_DIR);
      await fs.writeFile(path.join(START_LOCK_DIR, "pid"), `${process.pid}\n`, "utf8");
      return async () => {
        try {
          const pidFile = path.join(START_LOCK_DIR, "pid");
          const raw = (await fs.readFile(pidFile, "utf8")).trim();
          if (!raw || Number(raw) === process.pid) {
            await fs.rm(START_LOCK_DIR, { recursive: true, force: true });
          }
        } catch {
          await fs.rm(START_LOCK_DIR, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      const pidPath = path.join(START_LOCK_DIR, "pid");
      let lockPid: number | null = null;
      try {
        const raw = (await fs.readFile(pidPath, "utf8")).trim();
        const parsed = Number(raw);
        lockPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      } catch {
        lockPid = null;
      }

      if (!lockPid || !isPidAlive(lockPid)) {
        await fs.rm(START_LOCK_DIR, { recursive: true, force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the production server startup lock.");
      }

      await Bun.sleep(200);
    }
  }
}

async function ensureConsoleAdminToken(db: DatabaseManager): Promise<void> {
  const todayUtc = currentUtcDateString();
  const storedToken = (db.getConfigSync("AILOOP_CONSOLE_ADMIN_TOKEN") ?? "").trim();
  const storedIssuedDate = (db.getConfigSync("AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE") ?? "").trim();

  if (storedToken && storedIssuedDate) {
    const tokenAgeDays = ageInDays(todayUtc, storedIssuedDate);
    if (tokenAgeDays >= 0 && tokenAgeDays < 7) {
      const expires = expiryDate(storedIssuedDate);
      console.log(`Using console admin token from database (issued on ${storedIssuedDate}).`);
      console.log(
        expires
          ? `This token is valid for 7 UTC days (expires on ${expires} UTC).`
          : "This token is valid for 7 UTC days from issuance."
      );
      console.log(storedToken);
      console.log("(Tip: copy this token and paste it into the web login page.)");
      return;
    }

    await db.deleteConfig("AILOOP_CONSOLE_ADMIN_TOKEN");
    await db.deleteConfig("AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE");
    await fs.rm(TOKEN_CACHE_FILE, { force: true });
  }

  let issuedDate = todayUtc;
  let token = "";

  try {
    const cached = (await fs.readFile(TOKEN_CACHE_FILE, "utf8")).trim().split(/\s+/, 2);
    const [cachedIssuedDate = "", cachedToken = ""] = cached;
    const tokenAgeDays = ageInDays(todayUtc, cachedIssuedDate);
    if (cachedToken && tokenAgeDays >= 0 && tokenAgeDays < 7) {
      issuedDate = cachedIssuedDate;
      token = cachedToken;
      console.log(`Console admin token missing from database; reusing token issued on ${cachedIssuedDate} (age: ${tokenAgeDays} days).`);
    }
  } catch {
    // No cache is fine.
  }

  if (!token) {
    token = randomBytes(24).toString("hex");
    await fs.mkdir(RUN_DIR, { recursive: true });
    await fs.writeFile(TOKEN_CACHE_FILE, `${todayUtc} ${token}\n`, { mode: 0o600 });
    console.log(`Console admin token missing from database; generated new token (issued on ${todayUtc}).`);
  }

  await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN", token);
  await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE", issuedDate);
  const expires = expiryDate(issuedDate);
  console.log(
    expires
      ? `This token is valid for 7 UTC days (expires on ${expires} UTC).`
      : "This token is valid for 7 UTC days from issuance."
  );
  console.log(token);
  console.log("(Tip: copy this token and paste it into the web login page.)");
}

async function stopServer(): Promise<void> {
  const pid = await readPidFile();
  if (!pid) {
    await fs.rm(PID_FILE, { force: true });
    console.log("AILoop Production server is not running (PID file not found).");
    return;
  }

  if (!isPidAlive(pid)) {
    await fs.rm(PID_FILE, { force: true });
    console.log("AILoop Production server is not running (stale PID file cleaned).");
    return;
  }

  console.log(`Stopping AILoop Production server (PID: ${pid})...`);
  await stopProcess(pid, STOP_TIMEOUT_MS);
  await fs.rm(PID_FILE, { force: true });
  await clearLoopFlags();
  console.log("Stopped.");
}

async function startDaemon(): Promise<void> {
  const releaseLock = await acquireStartLock();

  try {
    const pid = await readPidFile();
    if (pid && isPidAlive(pid)) {
      console.log(`AILoop Production server is already running (PID: ${pid}).`);
      console.log(`Log: ${path.relative(ROOT_DIR, LOG_FILE)}`);
      return;
    }

    await fs.rm(PID_FILE, { force: true });
    await ensureDependenciesInstalled();

    const config = loadConfig({ workspaceRoot: ROOT_DIR });
    const db = new DatabaseManager({ dbPath: resolveConfigDbPath(config.homeDir) });
    try {
      await ensureConsoleAdminToken(db);
    } finally {
      db.close();
    }

    runCommand(BUN_BIN!, ["run", "web:build"]);

    console.log(`AILoop Production server is running at http://127.0.0.1:${config.consolePort}`);
    console.log("Use the web console for all loop operations and parameter settings.");

    const serverPid = spawnDetachedProcess({
      command: BUN_BIN!,
      args: ["run", "src/server.ts"],
      cwd: ROOT_DIR,
      logPath: LOG_FILE,
      env: process.env
    });
    await writePidFile(serverPid);

    const healthUrl = `http://127.0.0.1:${config.consolePort}/api/health`;
    const healthy = await waitForHttpHealth(healthUrl, serverPid, STARTUP_TIMEOUT_MS);
    if (!healthy) {
      await fs.rm(PID_FILE, { force: true });
      await stopProcess(serverPid, 1_000);
      throw new Error(`Production server failed to become healthy on port ${config.consolePort}. Check ${path.relative(ROOT_DIR, LOG_FILE)}.`);
    }

    console.log("Started in background daemon mode.");
    console.log(`PID: ${serverPid}`);
    console.log(`Log: ${path.relative(ROOT_DIR, LOG_FILE)}`);
    console.log(`Tip: Use 'tail -f ${path.relative(ROOT_DIR, LOG_FILE)}' to monitor the server.`);
  } finally {
    await releaseLock();
  }
}

async function runForeground(): Promise<void> {
  await ensureDependenciesInstalled();

  const config = loadConfig({ workspaceRoot: ROOT_DIR });
  const db = new DatabaseManager({ dbPath: resolveConfigDbPath(config.homeDir) });
  try {
    await ensureConsoleAdminToken(db);
  } finally {
    db.close();
  }

  runCommand(BUN_BIN!, ["run", "web:build"]);
  console.log(`AILoop Production server is running at http://127.0.0.1:${config.consolePort}`);
  console.log("Use the web console for all loop operations and parameter settings.");
  startConsoleServer({ config: loadConfig({ workspaceRoot: ROOT_DIR }) });
}

async function main(): Promise<void> {
  if (!BUN_BIN) {
    throw new Error("bun is required but was not found in PATH.");
  }

  process.chdir(ROOT_DIR);
  const mode = process.argv[2] ?? "foreground";

  if (!["foreground", "daemon", "stop", "restart"].includes(mode)) {
    throw new Error("Usage: scripts/prod.ts [foreground|daemon|stop|restart]");
  }

  if (mode === "stop") {
    await stopServer();
    return;
  }

  if (mode === "restart") {
    console.log("Restart requested: stopping current server gracefully.");
    await stopServer();
    await startDaemon();
    return;
  }

  if (mode === "daemon") {
    await startDaemon();
    return;
  }

  await runForeground();
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
