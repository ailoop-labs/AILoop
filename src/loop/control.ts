import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "../config/env";
import { readRuntimeLoopConfig, runtimeLoopConfigToEnv } from "../config/runtime";
import { listRunRecords, readLastLogTail } from "../reporting/summary";
import type { LoopStateData } from "../types/contracts";
import { readJsonFile } from "../utils/fs";
import {
  appendInstruction,
  buildLoopPaths,
  clearFlag,
  defaultLoopState,
  ensureLoopHome,
  readLoopState,
  readPid,
  setFlag,
  writeLoopState
} from "./state";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startBackgroundLoop(config: AppConfig): Promise<{ started: boolean; message: string }> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);

  const existingPid = await readPid(paths);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, message: `Loop already running with pid ${existingPid}` };
  }

  await clearFlag(paths.stopFlagPath);
  const runtimeConfig = await readRuntimeLoopConfig(config);
  const runtimeEnv = runtimeLoopConfigToEnv(runtimeConfig);
  const child = spawn("bun", ["run", "scripts/autoloop.ts", "run"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...runtimeEnv
    }
  });
  child.unref();

  return { started: true, message: `Loop started with pid ${child.pid}` };
}

export async function stopLoop(config: AppConfig): Promise<void> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  await setFlag(paths.stopFlagPath);
}

export async function pauseLoop(config: AppConfig): Promise<void> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  await setFlag(paths.pauseFlagPath);
}

export async function resumeLoop(config: AppConfig): Promise<void> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  await clearFlag(paths.pauseFlagPath);
}

export async function instructLoop(config: AppConfig, message: string): Promise<void> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  await appendInstruction(paths, message);
}

export async function getLoopStatus(config: AppConfig): Promise<LoopStateData & { pid_alive: boolean }> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);

  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  if (state.state === "running" && !pidAlive) {
    const recovered = defaultLoopState(null);
    recovered.last_error = "Process was not alive during status check";
    await writeLoopState(paths, recovered);
    return { ...recovered, pid_alive: false };
  }

  if (!pidAlive && state.state !== "running") {
    const normalized = {
      ...state,
      pid: null
    };
    await writeLoopState(paths, normalized);
    return {
      ...normalized,
      pid_alive: false
    };
  }

  return {
    ...state,
    pid: pid ?? null,
    pid_alive: pidAlive
  };
}

export async function listRuns(config: AppConfig, limit = 20): Promise<
  Array<{
    timestamp: string;
    summary: string;
    metrics: Record<string, unknown> | null;
  }>
> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  const records = await listRunRecords(paths.runsDir, limit);

  const output: Array<{
    timestamp: string;
    summary: string;
    metrics: Record<string, unknown> | null;
  }> = [];

  for (const record of records) {
    const summary = await fs.readFile(record.summaryPath, "utf8");
    const metrics = await readJsonFile<Record<string, unknown> | null>(record.metricsPath, null);
    output.push({
      timestamp: record.timestamp,
      summary,
      metrics
    });
  }

  return output;
}

export async function tailLatestLog(config: AppConfig, lines = 200): Promise<string[]> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  const records = await listRunRecords(paths.runsDir, 1);
  if (records.length === 0) {
    return [];
  }

  return readLastLogTail(records[0].logPath, lines);
}

export function resolveWebDistPath(): string {
  return path.join(process.cwd(), "web", "dist");
}
