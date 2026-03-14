import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "./config/env";
import { readRuntimeLoopConfig, saveRuntimeLoopConfig } from "./config/runtime";
import { buildLoopPaths, defaultLoopState, readLoopState, writeLoopState } from "./loop/state";
import { writeActiveRequirementArtifact } from "./product/requirements";
import { DatabaseManager } from "./utils/db";

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

async function seedProjectRoles(paths: ReturnType<typeof buildLoopPaths>) {
  await Promise.all([
    fs.writeFile(paths.plannerRolePath, "# Planner Role\n", "utf8"),
    fs.writeFile(paths.executorRolePath, "# Executor Role\n", "utf8"),
    fs.writeFile(paths.evaluatorRolePath, "# Evaluator Role\n", "utf8"),
    fs.writeFile(paths.designerRolePath, "# Designer Role\n", "utf8"),
    fs.writeFile(paths.leaderRolePath, "# Leader Role\n", "utf8")
  ]);
}

async function seedLoopEntrypoint(workspaceRoot: string) {
  const scriptsDir = path.join(workspaceRoot, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(
    path.join(scriptsDir, "ailoop.ts"),
    [
      'import { Database } from "bun:sqlite";',
      'import path from "node:path";',
      "",
      'const homeDir = path.join(process.cwd(), ".ailoop");',
      'const dbPath = path.join(homeDir, "ailoop.db");',
      "await Bun.sleep(150);",
      'const db = new Database(dbPath, { create: true });',
      'const current = db.query("SELECT * FROM system_state WHERE id = 1").get();',
      "const updatedAt = new Date().toISOString();",
      'db.run(`',
      '  UPDATE system_state SET ',
      '    state = "running",',
      '    pid = ?,',
      '    updated_at = ?,',
      '    last_error = NULL',
      '  WHERE id = 1',
      '`, [process.pid, updatedAt]);',
      'db.close();',
      "await Bun.sleep(5_000);",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function waitForLoopState(
  fetchHandler: (request: Request) => Promise<Response>,
  token: string,
  expectedState: string,
  timeoutMs = 3_000
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));
    const body = (await response.json()) as {
      state: string;
      pid: number | null;
      pid_alive: boolean;
    };
    if (body.state === expectedState) {
      return body;
    }
    await Bun.sleep(25);
  }

  throw new Error(`Timed out waiting for loop state ${expectedState}`);
}

function extractPid(message: string): number | null {
  const match = message.match(/(\d+)$/);
  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function killIfAlive(pid: number | null) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The detached test process may already have exited.
  }
}

async function writeRunArtifacts(
  runsDir: string,
  timestamp: string,
  contents: {
    summary?: string;
    metrics?: Record<string, unknown>;
    evaluation?: Record<string, unknown>;
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
  if (contents.evaluation !== undefined) {
    await fs.writeFile(
      path.join(runsDir, `${timestamp}.round.evaluation.json`),
      `${JSON.stringify(contents.evaluation, null, 2)}\n`,
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

async function seedRoundHistory(
  homeDir: string,
  input: {
    round: number;
    timestamp: string;
    state?: string;
    decision?: string;
    justification?: string;
    rootCause?: string | null;
    dimensions?: Record<string, unknown>[];
  }
) {
  const db = new Database(path.join(homeDir, "ailoop.db"), { create: true });

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS rounds (
        round_id INTEGER PRIMARY KEY,
        run_timestamp TEXT,
        state TEXT,
        last_error TEXT,
        consecutive_evaluator_failures INTEGER DEFAULT 0,
        usd_used REAL DEFAULT 0,
        actions_used INTEGER DEFAULT 0,
        elapsed_ms INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER,
        decision TEXT,
        justification TEXT,
        root_cause TEXT,
        dimensions_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db
      .prepare(
        `
        INSERT INTO rounds (round_id, run_timestamp, state, usd_used, actions_used, elapsed_ms)
        VALUES (?, ?, ?, 0, 0, 0)
      `
      )
      .run(input.round, input.timestamp, input.state ?? "completed");

    if (input.decision) {
      db
        .prepare(
          `
          INSERT INTO evaluations (round_id, decision, justification, root_cause, dimensions_json)
          VALUES (?, ?, ?, ?, ?)
        `
        )
        .run(
          input.round,
          input.decision,
          input.justification ?? "",
          input.rootCause ?? null,
          input.dimensions ? JSON.stringify(input.dimensions) : null
        );
    }
  } finally {
    db.close();
  }
}

async function seedGovernanceDetails(
  homeDir: string,
  input: {
    round: number;
    leader: {
      rationale: string;
      action: string;
      diagnosisType: string;
      instructions: string[];
    };
    ccb: {
      proposedChange: string;
      finalDecision: string;
      experts: Array<{
        expertRole: string;
        vote: string;
        rationale: string;
        incapacityFlag?: boolean;
      }>;
    };
  }
) {
  const db = new Database(path.join(homeDir, "ailoop.db"), { create: true });

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS leader_strategies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER,
        rationale TEXT,
        action TEXT,
        instructions_json TEXT,
        diagnosis_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS ccb_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER,
        proposed_change TEXT,
        final_decision TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS expert_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        expert_role TEXT,
        vote TEXT,
        rationale TEXT,
        incapacity_flag INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db
      .prepare(
        `
        INSERT INTO leader_strategies (round_id, rationale, action, instructions_json, diagnosis_type)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(
        input.round,
        input.leader.rationale,
        input.leader.action,
        JSON.stringify(input.leader.instructions),
        input.leader.diagnosisType
      );

    const ccbResult = db
      .prepare(
        `
        INSERT INTO ccb_sessions (round_id, proposed_change, final_decision)
        VALUES (?, ?, ?)
      `
      )
      .run(input.round, input.ccb.proposedChange, input.ccb.finalDecision);

    const sessionId = Number(ccbResult.lastInsertRowid);
    const insertExpertOpinion = db.prepare(
      `
      INSERT INTO expert_opinions (session_id, expert_role, vote, rationale, incapacity_flag)
      VALUES (?, ?, ?, ?, ?)
    `
    );

    for (const expert of input.ccb.experts) {
      insertExpertOpinion.run(
        sessionId,
        expert.expertRole,
        expert.vote,
        expert.rationale,
        expert.incapacityFlag ? 1 : 0
      );
    }
  } finally {
    db.close();
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
      service: "ailoop-console",
      db: "connected"
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
        }
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
        }
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

  test("returns JSON 500 instead of an HTML fallback page when friction-index telemetry throws", async () => {
    const token = "test-token";
    const originalGetFrictionIndex = DatabaseManager.prototype.getFrictionIndex;
    DatabaseManager.prototype.getFrictionIndex = async function getFrictionIndexFailure() {
      throw new Error("disk I/O error");
    };

    try {
      const { fetchHandler } = await createFixture({
        consoleAdminToken: token
      });

      const response = await fetchHandler(
        createAuthorizedRequest("http://console.test/api/metrics/friction-index", token)
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        ok: false,
        error: "Internal Server Error"
      });
    } finally {
      DatabaseManager.prototype.getFrictionIndex = originalGetFrictionIndex;
    }
  });

  test("returns the active requirement snapshot inside authenticated loop status responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 4
    });
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Operator Clarity",
        "",
        "## Problem",
        "Operators need to inspect the active requirement without leaving the console.",
        "",
        "## Acceptance Criteria",
        "- The status API exposes the current requirement summary.",
        "- The console can render the full requirement markdown."
      ].join("\n")
    );

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "paused",
      round: 4,
      pid: null,
      pid_alive: false,
      last_error: null,
      consecutive_evaluator_failures: 0,
      previous_tool_result: null,
      current_budget: null,
      updated_at: expect.any(String),
      active_requirement: {
        path: paths.activeRequirementPath,
        exists: true,
        artifact_status: "ready",
        lifecycle_status: "active",
        title: "Requirement Slice: Operator Clarity",
        summary: "Operators need to inspect the active requirement without leaving the console.",
        acceptance_criteria_total: 2,
        acceptance_criteria_completed: 0,
        markdown: expect.stringContaining("# Requirement Slice: Operator Clarity"),
        updated_at: expect.any(String)
      }
    });
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

  test("persists runtime config overrides through the authenticated save endpoint", async () => {
    const token = "test-token";
    const { config, fetchHandler } = await createFixture({
      consoleAdminToken: token
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/config", token, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          intervalSeconds: 90,
          exitOnError: true,
          budget: {
            timeMinutes: 25
          },
          codex: {
            profile: "saved-from-console",
            timeoutMs: 240_000
          }
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      config: await readRuntimeLoopConfig(config)
    });
    expect(await readRuntimeLoopConfig(config)).toMatchObject({
      intervalSeconds: 90,
      exitOnError: true,
      budget: {
        usdPerRound: 0.5,
        timeMinutes: 25,
        actions: 30
      },
      codex: {
        profile: "saved-from-console",
        timeoutMs: 240_000
      }
    });
  });

  test("restores default runtime config through the authenticated reset endpoint", async () => {
    const token = "test-token";
    const { config, fetchHandler } = await createFixture({
      consoleAdminToken: token
    });

    await saveRuntimeLoopConfig(config, {
      intervalSeconds: 45,
      maxCycles: 9,
      exitOnError: true,
      budget: {
        usdPerRound: 2,
        timeMinutes: 20,
        actions: 40
      },
      codex: {
        profile: "reset-me",
        timeoutMs: 240_000
      }
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/config/reset", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      config: {
        intervalSeconds: 30,
        maxCycles: 0,
        exitOnError: false,
        evaluatorReworkMaxAttempts: 1,
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
      }
    });
    expect(await readRuntimeLoopConfig(config)).toEqual({
      intervalSeconds: 30,
      maxCycles: 0,
      exitOnError: false,
      evaluatorReworkMaxAttempts: 1,
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
    });
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

  test("starts the loop for authenticated requests and reaches running after starting", async () => {
    const token = "test-token";
    const { fetchHandler, paths, workspaceRoot } = await createFixture({
      consoleAdminToken: token
    });

    await seedProjectRoles(paths);
    await seedLoopEntrypoint(workspaceRoot);
    await fs.writeFile(paths.stopFlagPath, "1\n", "utf8");
    await fs.writeFile(paths.pauseFlagPath, "1\n", "utf8");

    let startedPid: number | null = null;
    try {
      const response = await fetchHandler(
        createAuthorizedRequest("http://console.test/api/loop/start", token, {
          method: "POST"
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { started: boolean; message: string };
      expect(body.started).toBe(true);
      expect(body.message).toMatch(/^Loop started with pid \d+$/);
      expect(await fs.stat(paths.stopFlagPath).catch(() => null)).toBeNull();
      expect(await fs.stat(paths.pauseFlagPath).catch(() => null)).toBeNull();

      startedPid = extractPid(body.message);
      expect(startedPid).not.toBeNull();

      const startingState = await readLoopState(paths);
      expect(startingState.state).toBe("starting");
      expect(startingState.pid).toBe(startedPid);

      const runningStatus = await waitForLoopState(fetchHandler, token, "running");
      expect(runningStatus.pid).toBe(startedPid);
      expect(runningStatus.pid_alive).toBe(true);
    } finally {
      killIfAlive(startedPid);
    }
  });

  test("sets the pause flag for authenticated requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/pause", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await fs.readFile(paths.pauseFlagPath, "utf8")).toBe("1\n");
  });

  test("clears the pause flag and marks paused loops as running for authenticated requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await fs.writeFile(paths.pauseFlagPath, "1\n", "utf8");
    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "paused",
      pid: process.pid
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/resume", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await fs.stat(paths.pauseFlagPath).catch(() => null)).toBeNull();

    const state = await readLoopState(paths);
    expect(state.state).toBe("running");
    expect(state.pid).toBe(process.pid);
  });

  test("restarts a paused loop without a live pid for authenticated resume requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths, workspaceRoot } = await createFixture({
      consoleAdminToken: token
    });

    await seedProjectRoles(paths);
    await seedLoopEntrypoint(workspaceRoot);
    await fs.writeFile(paths.pauseFlagPath, "1\n", "utf8");
    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      pid: null
    });

    let restartedPid: number | null = null;
    try {
      const response = await fetchHandler(
        createAuthorizedRequest("http://console.test/api/loop/resume", token, {
          method: "POST"
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await fs.stat(paths.pauseFlagPath).catch(() => null)).toBeNull();

      const startingState = await readLoopState(paths);
      expect(startingState.state).toBe("starting");
      expect(startingState.pid).not.toBeNull();
      restartedPid = startingState.pid;

      const runningStatus = await waitForLoopState(fetchHandler, token, "running");
      expect(runningStatus.pid).toBe(restartedPid);
      expect(runningStatus.pid_alive).toBe(true);
    } finally {
      killIfAlive(restartedPid);
    }
  });

  test("sets the stop flag for authenticated requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/stop", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await fs.readFile(paths.stopFlagPath, "utf8")).toBe("1\n");
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
    expect(paths.instructionsPath).toBe(path.join(paths.homeDir, "instructions.queue.json"));
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
    const { config, fetchHandler, paths } = await createFixture({
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
      evaluation: {
        decision: "pass",
        justification: "All checks satisfied.",
        evidence: ["bun test src/server.test.ts"],
        aggregate_score: 96,
        recommended_next_action: "Continue to the next round.",
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "pass",
            score: 98,
            confidence: 0.9,
            justification: "The artifact retains structured evaluator output.",
            evidence: ["artifact-backed payload"],
            blocking_issues: []
          }
        ]
      },
      log: "latest log\n",
      stateChange: "latest diff\n"
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-10T11-00-00-000Z", {
      summary: "Incomplete summary\n",
      log: "incomplete log\n"
    });
    await seedRoundHistory(config.homeDir, {
      round: 2,
      timestamp: "2026-03-10T10-00-00-000Z",
      decision: "pass",
      justification: "DB summary should not replace artifact-backed evaluation fields.",
      rootCause: "db_only_summary"
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/runs?limit=1", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        timestamp: "2026-03-10T10-00-00-000Z",
        round: 2,
        summary: "Latest summary\n",
        metrics: {
          round: 2,
          status: "success"
        },
        evaluation: {
          decision: "pass",
          justification: "All checks satisfied.",
          evidence: ["bun test src/server.test.ts"],
          aggregate_score: 96,
          recommended_next_action: "Continue to the next round.",
          dimensions: [
            {
              dimension: "goal_alignment",
              decision: "pass",
              score: 98,
              confidence: 0.9,
              justification: "The artifact retains structured evaluator output.",
              evidence: ["artifact-backed payload"],
              blocking_issues: []
            }
          ]
        },
        has_governance: false
      }
    ]);
  });

  test("redacts secret-like values from authenticated run history responses", async () => {
    const token = "test-token";
    const { config, fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeRunArtifacts(paths.runsDir, "2026-03-10T10-45-00-000Z", {
      summary: "Older summary\n",
      metrics: { round: 2, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Older evaluation.",
        evidence: ["older evidence"]
      },
      log: "older log\n",
      stateChange: "older diff\n"
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-10T11-00-00-000Z", {
      summary: "Latest summary sessionSecret=uniquesecret123\n",
      metrics: { round: 3, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Validated apiToken=uniquesecret123.",
        evidence: ["sessionSecret=uniquesecret123"],
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "pass",
            score: 98,
            confidence: 0.9,
            justification: "Nested apiToken=uniquesecret123 stayed visible.",
            evidence: ["sessionSecret=uniquesecret123"],
            blocking_issues: []
          }
        ]
      },
      log: "latest log\n",
      stateChange: "latest diff\n"
    });
    await seedRoundHistory(config.homeDir, {
      round: 3,
      timestamp: "2026-03-10T11-00-00-000Z",
      decision: "pass",
      justification: "DB history should not reintroduce apiToken=uniquesecret123 values.",
      rootCause: "sessionSecret=uniquesecret123"
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/runs?limit=1", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        timestamp: "2026-03-10T11-00-00-000Z",
        round: 3,
        summary: "Latest summary sessionSecret=[REDACTED]\n",
        metrics: {
          round: 3,
          status: "success"
        },
        evaluation: {
          decision: "pass",
          justification: "Validated apiToken=[REDACTED].",
          evidence: ["sessionSecret=[REDACTED]"],
          dimensions: [
            {
              dimension: "goal_alignment",
              decision: "pass",
              score: 98,
              confidence: 0.9,
              justification: "Nested apiToken=[REDACTED] stayed visible.",
              evidence: ["sessionSecret=[REDACTED]"],
              blocking_issues: []
            }
          ]
        },
        has_governance: false
      }
    ]);
  });

  test("returns a specific completed run artifact bundle for authenticated requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const timestamp = "2026-03-10T10-00-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "Latest summary\n",
      metrics: { round: 2, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "All checks satisfied.",
        evidence: ["bun test src/server.test.ts"],
        aggregate_score: 96
      },
      log: "OPENAI_API_KEY=[REDACTED]\n",
      stateChange: "+SESSION_SECRET=[REDACTED]\n"
    });
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Artifact Visibility",
        "",
        "## Problem",
        "Operators need the selected run report to show the current requirement context.",
        "",
        "## Acceptance Criteria",
        "- The run artifact bundle returns the active requirement snapshot."
      ].join("\n")
    );

    const response = await fetchHandler(
      createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timestamp,
      summary: "Latest summary\n",
      metrics: {
        round: 2,
        status: "success"
      },
      evaluation: {
        decision: "pass",
        justification: "All checks satisfied.",
        evidence: ["bun test src/server.test.ts"],
        aggregate_score: 96
      },
      log: "OPENAI_API_KEY=[REDACTED]\n",
      state_change: "+SESSION_SECRET=[REDACTED]\n",
      active_requirement: {
        path: paths.activeRequirementPath,
        exists: true,
        artifact_status: "ready",
        lifecycle_status: "active",
        title: "Requirement Slice: Artifact Visibility",
        summary: "Operators need the selected run report to show the current requirement context.",
        acceptance_criteria_total: 1,
        acceptance_criteria_completed: 0,
        markdown: expect.stringContaining("# Requirement Slice: Artifact Visibility"),
        updated_at: expect.any(String)
      },
      governance: {
        leader: null,
        ccb: null
      }
    });
  });

  test("returns governance details alongside a selected run artifact bundle", async () => {
    const token = "test-token";
    const { config, fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const timestamp = "2026-03-10T11-00-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "Governed summary\n",
      metrics: { round: 3, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Governance trail preserved.",
        evidence: ["bun test src/server.test.ts"],
        aggregate_score: 97
      },
      log: "round log\n",
      stateChange: "+state change\n"
    });
    await seedRoundHistory(config.homeDir, {
      round: 3,
      timestamp,
      decision: "pass",
      justification: "Governance trail persisted."
    });
    await seedGovernanceDetails(config.homeDir, {
      round: 3,
      leader: {
        rationale: "Retry with a narrower API patch.",
        action: "resume",
        diagnosisType: "implementation_failure",
        instructions: ["Return governance data with the artifact bundle."]
      },
      ccb: {
        proposedChange: "None.",
        finalDecision: "reject",
        experts: [
          {
            expertRole: "senior_dev",
            vote: "reject",
            rationale: "README changes are unnecessary."
          },
          {
            expertRole: "qa_lead",
            vote: "reject",
            rationale: "A targeted API fix is sufficient."
          }
        ]
      }
    });

    const response = await fetchHandler(
      createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timestamp,
      summary: "Governed summary\n",
      metrics: {
        round: 3,
        status: "success"
      },
      evaluation: {
        decision: "pass",
        justification: "Governance trail preserved.",
        evidence: ["bun test src/server.test.ts"],
        aggregate_score: 97
      },
      log: "round log\n",
      state_change: "+state change\n",
      active_requirement: {
        path: paths.activeRequirementPath,
        exists: false,
        artifact_status: "missing",
        lifecycle_status: "active",
        title: null,
        summary: null,
        acceptance_criteria_total: 0,
        acceptance_criteria_completed: 0,
        markdown: null,
        updated_at: null
      },
      governance: {
        leader: {
          rationale: "Retry with a narrower API patch.",
          action: "resume",
          diagnosis_type: "implementation_failure",
          instructions: ["Return governance data with the artifact bundle."]
        },
        ccb: {
          proposed_change: "None.",
          final_decision: "reject",
          experts: [
            {
              expert_role: "senior_dev",
              vote: "reject",
              rationale: "README changes are unnecessary.",
              incapacity_flag: false
            },
            {
              expert_role: "qa_lead",
              vote: "reject",
              rationale: "A targeted API fix is sufficient.",
              incapacity_flag: false
            }
          ]
        }
      }
    });
  });

  test("redacts mixed-case secret assignments from archived run artifacts at serve time", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const timestamp = "2026-03-10T10-30-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "Latest summary sessionSecret=uniquesecret123\n",
      metrics: { round: 3, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified for apiToken=uniquesecret123.",
        evidence: ["sessionSecret=uniquesecret123"]
      },
      log: "sessionSecret=uniquesecret123\n",
      stateChange: "+apiToken=uniquesecret123\n"
    });

    const response = await fetchHandler(
      createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timestamp,
      summary: "Latest summary sessionSecret=[REDACTED]\n",
      metrics: {
        round: 3,
        status: "success"
      },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified for apiToken=[REDACTED].",
        evidence: ["sessionSecret=[REDACTED]"]
      },
      log: "sessionSecret=[REDACTED]\n",
      state_change: "+apiToken=[REDACTED]\n",
      active_requirement: {
        path: paths.activeRequirementPath,
        exists: false,
        artifact_status: "missing",
        lifecycle_status: "active",
        title: null,
        summary: null,
        acceptance_criteria_total: 0,
        acceptance_criteria_completed: 0,
        markdown: null,
        updated_at: null
      },
      governance: {
        leader: null,
        ccb: null
      }
    });
  });

  test("rejects unauthenticated requests for run artifact bundles", async () => {
    const { fetchHandler } = await createFixture({
      consoleAdminToken: "test-token"
    });

    const response = await fetchHandler(
      new Request("http://console.test/api/runs/2026-03-10T10-00-00-000Z/artifacts")
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Unauthorized"
    });
  });

  test("returns not found when the requested run artifact bundle does not exist", async () => {
    const token = "test-token";
    const { fetchHandler } = await createFixture({
      consoleAdminToken: token
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/runs/2026-03-10T10-00-00-000Z/artifacts", token)
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Run artifacts not found"
    });
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

  test("redacts secret-like values in authenticated latest log tail responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeRunArtifacts(paths.runsDir, "2026-03-10T10-00-00-000Z", {
      log: "visible-line\nsessionSecret=uniquesecret123\napiToken=anothersecret456!\n"
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/logs/tail?lines=3", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lines: ["visible-line", "sessionSecret=[REDACTED]", "apiToken=[REDACTED]!"]
    });
  });
});
