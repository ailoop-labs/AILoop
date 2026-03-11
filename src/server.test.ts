import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "./config/env";
import { readRuntimeLoopConfig, saveRuntimeLoopConfig } from "./config/runtime";
import { buildLoopPaths, defaultLoopState, readLoopState, writeLoopState } from "./loop/state";

const ENV_KEYS = [
  "AILOOP_CONSOLE_ADMIN_TOKEN",
  "AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE",
  "AILOOP_CONSOLE_HOST",
  "AILOOP_CONSOLE_PORT",
  "AILOOP_HOME"
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);
const originalCwd = process.cwd();
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  process.chdir(originalCwd);

  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function loadHandler(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  const module = await import(`./server.ts?test=${Date.now()}-${Math.random()}`);
  expect(typeof module.createConsoleFetch).toBe("function");
  return module.createConsoleFetch();
}

function makeTestConfig(homeDir: string, consoleAdminToken = ""): AppConfig {
  return {
    homeDir,
    intervalSeconds: 30,
    maxCycles: 0,
    exitOnError: false,
    enableLeader: false,
    evaluatorReworkMaxAttempts: 1,
    consoleHost: "127.0.0.1",
    consolePort: 0,
    consoleAdminToken,
    maxRetainRuns: 10,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    codex: {
      bin: "codex",
      model: "gpt-5",
      profile: "test",
      plannerSandbox: "read-only",
      executorSandbox: "danger-full-access",
      evaluatorSandbox: "danger-full-access",
      timeoutMs: 180_000,
      llmEvaluatorDimensions: [
        "goal_alignment",
        "causal_validity",
        "constraint_compliance",
        "risk_externality",
        "reversibility_resilience",
        "learning_yield"
      ],
      llmEvaluatorMinPassScore: 75
    }
  };
}

async function createFixture(options: {
  consoleAdminToken?: string;
  adminTokenIssuedDate?: string;
  goal?: string;
} = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-server-test-"));
  tempDirs.add(workspaceRoot);

  const homeDir = path.join(workspaceRoot, ".ailoop");
  await fs.mkdir(homeDir, { recursive: true });

  if (options.goal) {
    await fs.writeFile(path.join(workspaceRoot, "GOAL.md"), options.goal, "utf8");
  } else {
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
  }

  process.chdir(workspaceRoot);

  const module = await import(`./server.ts?test=${Date.now()}-${Math.random()}`);
  expect(typeof module.createConsoleFetch).toBe("function");

  const config = makeTestConfig(homeDir, options.consoleAdminToken);
  return {
    config,
    fetchHandler: module.createConsoleFetch({
      config,
      adminTokenIssuedDate: options.adminTokenIssuedDate ?? "2026-03-11"
    }),
    paths: buildLoopPaths(homeDir),
    workspaceRoot
  };
}

function createAuthorizedRequest(url: string, token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-admin-token", token);
  return new Request(url, {
    ...init,
    headers
  });
}

async function writeRunArtifacts(
  runsDir: string,
  timestamp: string,
  contents: {
    summary?: string;
    metrics?: Record<string, unknown>;
    log?: string;
    stateChange?: string;
  }
) {
  await fs.mkdir(runsDir, { recursive: true });

  if (contents.summary !== undefined) {
    await fs.writeFile(path.join(runsDir, `${timestamp}.round.summary.md`), contents.summary, "utf8");
  }
  if (contents.metrics !== undefined) {
    await fs.writeFile(
      path.join(runsDir, `${timestamp}.round.metrics.json`),
      `${JSON.stringify(contents.metrics, null, 2)}\n`,
      "utf8"
    );
  }
  if (contents.log !== undefined) {
    await fs.writeFile(path.join(runsDir, `${timestamp}.round.log`), contents.log, "utf8");
  }
  if (contents.stateChange !== undefined) {
    await fs.writeFile(path.join(runsDir, `${timestamp}.round.state_change.txt`), contents.stateChange, "utf8");
  }
}

describe("console server API contract", () => {
  test("serves health status without auth", async () => {
    const fetchHandler = await loadHandler({
      AILOOP_CONSOLE_HOST: "127.0.0.1",
      AILOOP_CONSOLE_PORT: "0",
      AILOOP_CONSOLE_ADMIN_TOKEN: ""
    });

    const response = await fetchHandler(new Request("http://console.test/api/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "ailoop-console"
    });
  });

  test("reports auth status when token auth is enabled", async () => {
    const fetchHandler = await loadHandler({
      AILOOP_CONSOLE_HOST: "127.0.0.1",
      AILOOP_CONSOLE_PORT: "0",
      AILOOP_CONSOLE_ADMIN_TOKEN: "test-token",
      AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE: "2026-03-11"
    });

    const response = await fetchHandler(new Request("http://console.test/api/auth/status"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tokenRequired: true,
      tokenExpired: false
    });
  });

  test("rejects protected API access without a valid admin token", async () => {
    const fetchHandler = await loadHandler({
      AILOOP_CONSOLE_HOST: "127.0.0.1",
      AILOOP_CONSOLE_PORT: "0",
      AILOOP_CONSOLE_ADMIN_TOKEN: "test-token",
      AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE: "2026-03-11"
    });

    const response = await fetchHandler(new Request("http://console.test/api/status"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Unauthorized"
    });
  });

  test("returns loop status for authenticated requests", async () => {
    const token = "test-token";
    const { config, fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 7,
      pid: null,
      last_error: "Waiting for review",
      consecutive_evaluator_failures: 2,
      previous_tool_result: {
        status: "success",
        summary: "Previous round passed",
        artifacts: {
          state_change_path: "state-change.txt",
          log_path: "round.log"
        },
        error: null,
        next_state_hint: "continue"
      },
      current_budget: {
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 4,
          elapsedMs: 12_000
        }
      }
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      state: "paused",
      round: 7,
      pid: null,
      pid_alive: false,
      last_error: "Waiting for review",
      consecutive_evaluator_failures: 2,
      previous_tool_result: {
        status: "success",
        summary: "Previous round passed",
        artifacts: {
          state_change_path: "state-change.txt",
          log_path: "round.log"
        },
        error: null,
        next_state_hint: "continue"
      },
      current_budget: {
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 4,
          elapsedMs: 12_000
        }
      }
    });
    expect(body.updated_at).toEqual(expect.any(String));
    expect((await readLoopState(paths)).state).toBe("paused");
    expect(config.homeDir).toBe(paths.homeDir);
  });

  test("returns runtime config overrides for authenticated requests", async () => {
    const token = "test-token";
    const { config, fetchHandler } = await createFixture({
      consoleAdminToken: token
    });

    await saveRuntimeLoopConfig(config, {
      intervalSeconds: 45,
      maxCycles: 12,
      exitOnError: true,
      evaluatorReworkMaxAttempts: 3,
      budget: {
        usdPerRound: 7.25,
        timeMinutes: 22,
        actions: 44
      },
      codex: {
        profile: "console-test",
        timeoutMs: 240_000,
        llmEvaluatorDimensions: ["constraint_compliance", "learning_yield"],
        llmEvaluatorMinPassScore: 88
      }
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/config", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await readRuntimeLoopConfig(config));
  });

  test("returns the workspace goal for authenticated requests", async () => {
    const token = "test-token";
    const goal = "# Goal\n\nShip the operator console.\n";
    const { fetchHandler } = await createFixture({
      consoleAdminToken: token,
      goal
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/goal", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ goal });
  });

  test("appends operator instructions for authenticated requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/instruct", token, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          message: "Verify the production fix before resuming."
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(JSON.parse(await fs.readFile(paths.instructionsPath, "utf8"))).toEqual([
      "Verify the production fix before resuming."
    ]);
  });

  test("rejects empty operator instructions", async () => {
    const token = "test-token";
    const { fetchHandler } = await createFixture({
      consoleAdminToken: token
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/instruct", token, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          message: "   "
        })
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Missing message"
    });
  });

  test("lists the most recent complete run history entries", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeRunArtifacts(paths.runsDir, "2026-03-10T09-00-00-000Z", {
      summary: "Older summary\n",
      metrics: { round: 1, status: "success" },
      log: "older log\n",
      stateChange: "older diff\n"
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-10T10-00-00-000Z", {
      summary: "Latest summary\n",
      metrics: { round: 2, status: "success" },
      log: "latest log\n",
      stateChange: "latest diff\n"
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-10T11-00-00-000Z", {
      summary: "Incomplete summary\n",
      log: "incomplete log\n"
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/runs?limit=1", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        timestamp: "2026-03-10T10-00-00-000Z",
        summary: "Latest summary\n",
        metrics: {
          round: 2,
          status: "success"
        }
      }
    ]);
  });

  test("tails the newest round log with the requested line limit", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeRunArtifacts(paths.runsDir, "2026-03-10T09-00-00-000Z", {
      log: "older-1\nolder-2\n"
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-10T10-00-00-000Z", {
      log: "latest-1\nlatest-2\nlatest-3\n"
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/logs/tail?lines=2", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lines: ["latest-2", "latest-3"]
    });
  });
});
