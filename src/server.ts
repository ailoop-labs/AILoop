import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config/env";
import {
  getLoopStatus,
  instructLoop,
  listRuns,
  pauseLoop,
  resolveWebDistPath,
  resumeLoop,
  startBackgroundLoop,
  stopLoop,
  tailLatestLog
} from "./loop/control";

const config = loadConfig();

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

const server = Bun.serve({
  hostname: config.consoleHost,
  port: config.consolePort,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "autoloop-console" });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return json(await getLoopStatus(config));
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

    if (url.pathname === "/api/runs" && request.method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "20");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;
      return json(await listRuns(config, limit));
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
  }
});

console.log(`AutoLoop console server running on http://${server.hostname}:${server.port}`);
