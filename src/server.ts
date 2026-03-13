import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config/env";
import { patchRuntimeLoopConfig, readRuntimeLoopConfig, resetRuntimeLoopConfig } from "./config/runtime";
import { isDateBasedAdminTokenExpired } from "./auth/admin-token";
import { DatabaseManager } from "./utils/db";
import {
  getLoopStatus,
  getRunArtifacts,
  instructLoop,
  listProjectRoles,
  listRuns,
  pauseLoop,
  readGoal,
  resolveWebDistPath,
  resumeLoop,
  startBackgroundLoop,
  stopLoop,
  tailLatestLog
} from "./loop/control";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractRequestToken(request: Request): string {
  const bearer = request.headers.get("authorization") ?? "";
  if (bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }

  return (request.headers.get("x-admin-token") ?? "").trim();
}

function isPublicApi(pathname: string, method: string): boolean {
  return (
    (pathname === "/api/health" && method === "GET") ||
    (pathname === "/api/auth/status" && method === "GET") ||
    (pathname === "/api/auth/login" && method === "POST")
  );
}

interface ConsoleRuntime {
  config: AppConfig;
  adminToken: string;
  tokenAuthEnabled: boolean;
  adminTokenIssuedDate: string;
  db: DatabaseManager;
}

interface CreateConsoleFetchOptions {
  config?: AppConfig;
  adminTokenIssuedDate?: string;
}

function createConsoleRuntime(options: CreateConsoleFetchOptions = {}): ConsoleRuntime {
  const config = options.config ?? loadConfig();
  const adminToken = config.consoleAdminToken.trim();
  const dbPath = path.join(config.homeDir, "ailoop.db");

  return {
    config,
    adminToken,
    tokenAuthEnabled: adminToken.length > 0,
    adminTokenIssuedDate:
      options.adminTokenIssuedDate ?? (process.env.AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE ?? "").trim(),
    db: new DatabaseManager({ dbPath })
  };
}

async function serveStaticFromDist(urlPath: string): Promise<Response | null> {
  const distDir = resolveWebDistPath();
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = path.normalize(requested).replace(/^\.\.(\/|\\|$)/, "");
  const fullPath = path.join(distDir, safePath);

  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      return null;
    }

    const body = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const contentType =
      ext === ".html"
        ? "text/html"
        : ext === ".js"
          ? "text/javascript"
          : ext === ".css"
            ? "text/css"
            : ext === ".json"
              ? "application/json"
              : ext === ".svg"
                ? "image/svg+xml"
                : "application/octet-stream";

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType
      }
    });
  } catch {
    return null;
  }
}

function createConsoleFetchFromRuntime(runtime: ConsoleRuntime) {
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { config, adminToken, tokenAuthEnabled, adminTokenIssuedDate, db } = runtime;

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "ailoop-console", db: "connected" });
    }

    if (url.pathname === "/api/auth/status" && request.method === "GET") {
      return json({
        tokenRequired: tokenAuthEnabled,
        tokenExpired: isDateBasedAdminTokenExpired({ tokenAuthEnabled, adminTokenIssuedDate })
      });
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!tokenAuthEnabled) {
        return json({ ok: true, tokenRequired: false });
      }
      if (isDateBasedAdminTokenExpired({ tokenAuthEnabled, adminTokenIssuedDate })) {
        return json({ ok: false, error: "Token expired. Restart production server to generate a new token." }, 401);
      }

      const body = await parseBody(request);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || token !== adminToken) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      return json({ ok: true, tokenRequired: true });
    }

    if (url.pathname.startsWith("/api/") && tokenAuthEnabled && !isPublicApi(url.pathname, request.method)) {
      if (isDateBasedAdminTokenExpired({ tokenAuthEnabled, adminTokenIssuedDate })) {
        return json({ ok: false, error: "Token expired. Restart production server to generate a new token." }, 401);
      }

      const token = extractRequestToken(request);
      if (!token || token !== adminToken) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return json(await getLoopStatus(config));
    }

    if (url.pathname === "/api/metrics/friction-index" && request.method === "GET") {
      return json(await db.getFrictionIndex());
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      return json(await readRuntimeLoopConfig(config));
    }

    if (url.pathname === "/api/goal" && request.method === "GET") {
      return json({ goal: await readGoal(config) });
    }

    if (url.pathname === "/api/config" && request.method === "POST") {
      const body = await parseBody(request);
      return json({
        ok: true,
        config: await patchRuntimeLoopConfig(config, body)
      });
    }

    if (url.pathname === "/api/config/reset" && request.method === "POST") {
      return json({
        ok: true,
        config: await resetRuntimeLoopConfig(config)
      });
    }

    if (url.pathname === "/api/loop/start" && request.method === "POST") {
      return json(await startBackgroundLoop(config));
    }

    if (url.pathname === "/api/loop/stop" && request.method === "POST") {
      await stopLoop(config);
      return json({ ok: true });
    }

    if (url.pathname === "/api/loop/pause" && request.method === "POST") {
      await pauseLoop(config);
      return json({ ok: true });
    }

    if (url.pathname === "/api/loop/resume" && request.method === "POST") {
      await resumeLoop(config);
      return json({ ok: true });
    }

    if (url.pathname === "/api/loop/instruct" && request.method === "POST") {
      const body = await parseBody(request);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return json({ ok: false, error: "Missing message" }, 400);
      }
      await instructLoop(config, message);
      return json({ ok: true });
    }

    if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/governance") && request.method === "GET") {
      const parts = url.pathname.split("/");
      const roundId = Number(parts[3]);
      if (Number.isFinite(roundId)) {
        return json(await db.getGovernanceDetails(roundId));
      }
      return json({ error: "Invalid round ID" }, 400);
    }

    if (url.pathname === "/api/runs" && request.method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "20");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;
      const runs = await listRuns(config, limit);
      const payload = await Promise.all(
        runs.map(async (run) => {
          const governance =
            run.round > 0
              ? await db.getGovernanceDetails(run.round)
              : { leader: null, ccb: null };

          return {
            ...run,
            has_governance: Boolean(governance.leader || governance.ccb)
          };
        })
      );

      return json(payload);
    }

    const runArtifactsMatch =
      request.method === "GET" ? url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/) : null;
    if (runArtifactsMatch) {
      const timestamp = decodeURIComponent(runArtifactsMatch[1] ?? "");
      const artifacts = await getRunArtifacts(config, timestamp);
      if (!artifacts) {
        return json({ ok: false, error: "Run artifacts not found" }, 404);
      }

      const run = (await listRuns(config, Number.MAX_SAFE_INTEGER)).find((record) => record.timestamp === timestamp);
      const governance =
        run && run.round > 0
          ? await db.getGovernanceDetails(run.round)
          : { leader: null, ccb: null };

      return json({
        ...artifacts,
        governance
      });
    }

    if (url.pathname === "/api/roles" && request.method === "GET") {
      const roles = await listProjectRoles(config);
      return json({
        count: roles.length,
        roles
      });
    }

    if (url.pathname === "/api/logs/tail" && request.method === "GET") {
      const linesRaw = Number(url.searchParams.get("lines") ?? "200");
      const lines = Number.isFinite(linesRaw) ? Math.max(1, Math.min(2000, linesRaw)) : 200;
      return json({ lines: await tailLatestLog(config, lines) });
    }

    const staticFile = await serveStaticFromDist(url.pathname);
    if (staticFile) {
      return staticFile;
    }

    return json({ error: "Not Found" }, 404);
  };
}

export function createConsoleFetch(options: CreateConsoleFetchOptions = {}) {
  return createConsoleFetchFromRuntime(createConsoleRuntime(options));
}

export function startConsoleServer(options: CreateConsoleFetchOptions = {}) {
  const runtime = createConsoleRuntime(options);
  const server = Bun.serve({
    hostname: runtime.config.consoleHost,
    port: runtime.config.consolePort,
    idleTimeout: 255,
    fetch: createConsoleFetchFromRuntime(runtime)
  });

  console.log(`AILoop console server running on http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startConsoleServer();
}
