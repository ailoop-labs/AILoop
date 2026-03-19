import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "./config/env";
import { readRuntimeLoopConfig, saveRuntimeLoopConfig } from "./config/runtime";
import { buildLoopPaths, defaultLoopState, readLoopState, saveEvaluation, writeLoopState } from "./loop/state";
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

const HOT_FILE_GOVERNANCE_PAYLOAD = {
  file_path: "src/loop/engine.ts",
  heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
  result_class: "hot_file_growth_failure" as const,
  reason: "continued growth in pressured file without bounded justification",
  recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
};

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

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

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
      timeoutMs: 1_800_000,
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
      adminTokenIssuedDate: options.adminTokenIssuedDate ?? currentUtcDateString()
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

async function createExternalValidationCandidate(options?: {
  initializeGit?: boolean;
  includeTestInfrastructure?: boolean;
  dependencyCount?: number;
}): Promise<string> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-server-external-validation-"));
  tempDirs.add(repoDir);
  const {
    initializeGit = true,
    includeTestInfrastructure = true,
    dependencyCount = 1
  } = options ?? {};

  await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
  await fs.writeFile(path.join(repoDir, "src", "index.ts"), "export const value = 1;\n", "utf8");

  if (includeTestInfrastructure) {
    await fs.mkdir(path.join(repoDir, "test"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "test", "index.test.ts"),
      'import { expect, test } from "bun:test";\n\ntest("repo", () => {\n  expect(true).toBe(true);\n});\n',
      "utf8"
    );
  }

  const dependencies = Object.fromEntries(
    Array.from({ length: dependencyCount }, (_, index) => [`dep-${index}`, "1.0.0"])
  );
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "external-validation-candidate",
        private: true,
        scripts: includeTestInfrastructure ? { test: "bun test" } : {},
        dependencies
      },
      null,
      2
    ),
    "utf8"
  );

  if (initializeGit) {
    await Bun.$`git init`.cwd(repoDir).quiet();
  }

  return repoDir;
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
    hotFileGovernance?: Record<string, unknown> | null;
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
        hot_file_governance_json TEXT,
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
          INSERT INTO evaluations (round_id, decision, justification, root_cause, dimensions_json, hot_file_governance_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.round,
          input.decision,
          input.justification ?? "",
          input.rootCause ?? null,
          input.dimensions ? JSON.stringify(input.dimensions) : null,
          input.hotFileGovernance ? JSON.stringify(input.hotFileGovernance) : null
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
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-server-auth-status-"));
    tempDirs.add(workspaceRoot);

    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(workspaceRoot);

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });
    let fetchHandler;
    try {
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN", "test-token");
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE", currentUtcDateString());
      fetchHandler = await loadHandler({});
    } finally {
      db.close();
    }

    const response = await fetchHandler(new Request("http://console.test/api/auth/status"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tokenRequired: true,
      tokenExpired: false
    });
  });

  test("loads console auth settings from the workspace database instead of process env", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-server-db-config-"));
    tempDirs.add(workspaceRoot);

    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(workspaceRoot);

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });
    try {
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN", "db-token");
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE", currentUtcDateString());

      const fetchHandler = await loadHandler({
        AILOOP_HOME: "/tmp/not-the-workspace-home",
        AILOOP_CONSOLE_ADMIN_TOKEN: "env-token",
        AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE: "2000-01-01"
      });

      const statusResponse = await fetchHandler(new Request("http://console.test/api/auth/status"));
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toEqual({
        tokenRequired: true,
        tokenExpired: false
      });

      const loginResponse = await fetchHandler(
        new Request("http://console.test/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ token: "db-token" })
        })
      );

      expect(loginResponse.status).toBe(200);
      expect(await loginResponse.json()).toEqual({
        ok: true,
        tokenRequired: true
      });
    } finally {
      db.close();
    }
  });

  test("rejects protected API access without a valid admin token", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-server-auth-reject-"));
    tempDirs.add(workspaceRoot);

    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(workspaceRoot);

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });
    let fetchHandler;
    try {
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN", "test-token");
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE", currentUtcDateString());
      fetchHandler = await loadHandler({});
    } finally {
      db.close();
    }

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
      pause_reason: "Manual pause",
      crash_recovery: null,
      operator_reason: {
        kind: "manual_pause",
        title: "Manual pause",
        summary: "Waiting for review",
        next_action: "Inspect the run state and resume explicitly when safe.",
        severity: "warning"
      },
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
      },
      artifact_completeness: {
        kind: "none",
        label: "No artifacts yet",
        latest_round_timestamp: null,
        latest_artifact_at: null,
        present: [],
        missing: ["log", "summary", "metrics", "state_change", "evaluation"]
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

  test("returns recent hot-file pressure telemetry in the friction-index payload", async () => {
    const token = "test-token";
    const { config, fetchHandler } = await createFixture({
      consoleAdminToken: token
    });

    for (let round = 1; round <= 21; round += 1) {
      await seedRoundHistory(config.homeDir, {
        round,
        timestamp: `2026-03-15T00-${String(round).padStart(2, "0")}-00-000Z`,
        decision: round === 1 || round >= 20 ? "fail" : undefined,
        justification: round === 1 || round >= 20 ? "Governance blocked the round." : undefined,
        hotFileGovernance: round === 1 || round >= 20 ? HOT_FILE_GOVERNANCE_PAYLOAD : null
      });
    }

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/metrics/friction-index", token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reworkChurnRate: 0,
      averageActions: 0,
      leaderInterventionCount: 0,
      overEngineeringCount: 0,
      hotFilePressureCount: 2,
      healthStatus: "at_risk"
    });
  });

  test("returns persisted external-validation checklist aggregates for authenticated operators", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeRunArtifacts(paths.runsDir, "2026-03-18T01-00-00-000Z", {
      metrics: {
        round: 1,
        run_timestamp: "2026-03-18T01-00-00-000Z",
        duration_ms: 1_000,
        budget_limits: {
          usdPerRound: 1,
          timeMinutes: 10,
          actions: 10
        },
        budget_usage: {
          usdUsed: 0.2,
          elapsedMs: 1_000,
          actionsUsed: 2
        },
        evaluator_decision: "pass",
        tool_status: "success",
        retries: {
          evidence_remediation_attempts: 0,
          auto_rework_attempts: 0,
          auto_rework_limit: 2
        },
        phase_timings_ms: {
          planning: 100,
          execution: 500,
          evaluation: 300,
          operational_followup: 100
        },
        human_interventions: 1,
        hot_file_growth_lines: 5,
        sub_task_identity: {
          stable_id: "task-a",
          assignee: "designer",
          objective: "Surface pilot readiness in the Web Console",
          expected_outcome: "Operators can assess readiness without parsing CLI output."
        }
      },
      evaluation: {
        decision: "pass",
        justification: "Pilot summary metrics were persisted successfully.",
        evidence: ["bun test src/server.test.ts"]
      },
      summary: "Rendered the pilot readiness summary in the Web Console.",
      stateChange: "diff --git a/web/src/App.tsx b/web/src/App.tsx\n+++ b/web/src/App.tsx\n@@ -1 +1 @@\n+const ready = true;\n"
    });

    await writeRunArtifacts(paths.runsDir, "2026-03-18T02-00-00-000Z", {
      metrics: {
        round: 2,
        run_timestamp: "2026-03-18T02-00-00-000Z",
        duration_ms: 1_400,
        budget_limits: {
          usdPerRound: 1,
          timeMinutes: 10,
          actions: 10
        },
        budget_usage: {
          usdUsed: 0.4,
          elapsedMs: 1_400,
          actionsUsed: 3
        },
        evaluator_decision: "fail",
        tool_status: "failure",
        retries: {
          evidence_remediation_attempts: 0,
          auto_rework_attempts: 1,
          auto_rework_limit: 2
        },
        phase_timings_ms: {
          planning: 100,
          execution: 700,
          evaluation: 500,
          operational_followup: 100
        },
        human_interventions: 0,
        hot_file_growth_lines: 2,
        sub_task_identity: {
          stable_id: "task-b",
          assignee: "executor",
          objective: "Run the external-validation pilot on a fixture repository",
          expected_outcome: "The pilot completes without evaluator infrastructure faults."
        }
      },
      evaluation: {
        decision: "fail",
        justification: "Evaluator infrastructure failure: upstream timeout.",
        root_cause: "evaluator_infrastructure:upstream-timeout",
        evidence: ["bun test src/server.test.ts"]
      },
      summary: "The pilot remained blocked by evaluator infrastructure.",
      stateChange: "No state changes detected.\n"
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/metrics/external-validation", token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      task_count: 2,
      successful_task_count: 1,
      checklist: {
        rounds_per_successful_task: 1,
        human_interventions_per_task: 0.5,
        average_cost_usd_per_round: 0.3,
        evaluator_infrastructure_failures: 1,
        hot_file_growth_lines: 7
      },
      tasks: [
        expect.objectContaining({
          stable_id: "task-a",
          objective: "Surface pilot readiness in the Web Console",
          successful: true
        }),
        expect.objectContaining({
          stable_id: "task-b",
          objective: "Run the external-validation pilot on a fixture repository",
          successful: false
        })
      ]
    });
  });

  test("returns an authenticated Phase 3 preflight result for an eligible candidate repository", async () => {
    const token = "test-token";
    const { fetchHandler } = await createFixture({
      consoleAdminToken: token
    });
    const repoDir = await createExternalValidationCandidate();

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/external-validation/preflight", token, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ repoPath: repoDir })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repoPath: repoDir,
      result: {
        eligible: true,
        detectedTestCommand: "bun test",
        directDependencyCount: 1,
        checks: {
          gitRepository: true,
          javascriptOrTypescript: true,
          projectSizeWithinLimit: true,
          testInfrastructure: true,
          dependencyCountWithinLimit: true
        },
        failureReasons: []
      },
      report: expect.stringContaining("External validation preflight: PASS")
    });
  });

  test("returns expected Phase 3 failure reasons for an ineligible candidate repository", async () => {
    const token = "test-token";
    const { fetchHandler } = await createFixture({
      consoleAdminToken: token
    });
    const repoDir = await createExternalValidationCandidate({ includeTestInfrastructure: false });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/external-validation/preflight", token, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ repoPath: repoDir })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repoPath: repoDir,
      result: {
        eligible: false,
        detectedTestCommand: null,
        directDependencyCount: 1,
        checks: {
          gitRepository: true,
          javascriptOrTypescript: true,
          projectSizeWithinLimit: true,
          testInfrastructure: false,
          dependencyCountWithinLimit: true
        },
        failureReasons: ["Repository must expose a local test entrypoint and matching test infrastructure."]
      },
      report: expect.stringContaining("External validation preflight: FAIL")
    });
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
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 4,
      pid: null,
      pid_alive: false,
      crash_recovery: null,
      operator_reason: {
        kind: "manual_pause",
        title: "Manual pause",
        summary: "Run is paused and waiting for operator review.",
        next_action: "Inspect the run state and resume explicitly when safe.",
        severity: "warning"
      },
      last_error: null,
      consecutive_evaluator_failures: 0,
      previous_tool_result: null,
      budget_health: null,
      current_budget: null,
      goal_reference: {
        title: "Project Goal (Derived from README.md)",
        summary: "Project Goal (Derived from README.md)"
      },
      artifact_completeness: {
        kind: "none",
        label: "No artifacts yet",
        latest_round_timestamp: null,
        latest_artifact_at: null,
        present: [],
        missing: ["log", "summary", "metrics", "state_change", "evaluation"]
      },
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

  test("serializes latest artifact completeness in authenticated status responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 11
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-15T02-16-09-241Z", {
      summary: "partial summary",
      metrics: { round: 11 },
      log: "partial log"
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 11,
      artifact_completeness: {
        kind: "partial_bundle",
        label: "Partial bundle",
        latest_round_timestamp: "2026-03-15T02-16-09-241Z",
        latest_artifact_at: expect.any(String),
        present: ["log", "summary", "metrics"],
        missing: ["state_change", "evaluation"]
      }
    });
  });

  test("serializes budget health and breached dimension in authenticated status responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 12,
      last_error: "BudgetBreach: action budget exceeded",
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 2,
          actions: 10
        },
        usage: {
          usdUsed: 0.9,
          actionsUsed: 11,
          elapsedMs: 30_000
        }
      }
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 12,
      pause_reason: "Budget breach",
      operator_reason: {
        kind: "budget_breach",
        title: "Budget breach",
        summary: "Paused because the action budget was exceeded (11 / 10).",
        next_action: "Review the last budget snapshot and reduce scope or raise budgets before resuming.",
        severity: "critical"
      },
      budget_health: {
        overall: "breached",
        breached_dimension: "actions",
        dimensions: [
          {
            dimension: "cost",
            label: "USD",
            health: "warning",
            used: 0.9,
            limit: 1,
            ratio: 0.9
          },
          {
            dimension: "actions",
            label: "Actions",
            health: "breached",
            used: 11,
            limit: 10,
            ratio: 1.1
          },
          {
            dimension: "time",
            label: "Time",
            health: "healthy",
            used: 30_000,
            limit: 120_000,
            ratio: 0.25
          }
        ]
      },
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 2,
          actions: 10
        },
        usage: {
          usdUsed: 0.9,
          actionsUsed: 11,
          elapsedMs: 30_000
        }
      }
    });
  });

  test("serializes hot-file governance distinctly in authenticated status responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 13,
      last_error: "EvaluatorFailureLimit: repeated evaluator failures require operator review.",
      previous_hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 13,
      hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
      operator_reason: {
        kind: "hot_file_governance",
        title: "Hot-file governance block",
        next_action: "pause and split the next change into a bounded structural-maintenance pass",
        severity: "critical"
      }
    });
  });

  test("serializes evaluator strategic blocks distinctly from evaluator failure thresholds in authenticated status responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 14,
      last_error: "EvaluatorStrategicBlock: Further retries require immediate governance review.",
      previous_evaluation_dimensions: [
        {
          dimension: "constraint_compliance",
          decision: "fail",
          score: 61,
          confidence: 0.93,
          justification: "The round needs explicit governance review before another retry.",
          evidence: ["status artifact"],
          blocking_issues: ["Evaluator requested strategic governance escalation."],
          recommended_next_action:
            "Review the evaluator findings, adjust scope, and resume only after the governance issue is addressed."
        }
      ]
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 14,
      pause_reason: "Strategic evaluator block",
      hot_file_governance: null,
      operator_reason: {
        kind: "evaluator_strategic_block",
        title: "Strategic evaluator block",
        summary: "Further retries require immediate governance review.",
        next_action: "Review the evaluator findings, adjust scope, and resume only after the governance issue is addressed.",
        severity: "critical"
      }
    });
  });

  test("does not mislabel ordinary evaluator failure limits as hot-file governance in authenticated status responses", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 15,
      last_error: "EvaluatorFailureLimit: repeated evaluator failures require operator review."
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 15,
      hot_file_governance: null,
      operator_reason: {
        kind: "evaluator_failure_limit",
        title: "Evaluator failure threshold",
        summary: "repeated evaluator failures require operator review.",
        next_action: "Inspect the evaluator findings and narrow the next sub-task before resuming.",
        severity: "critical"
      }
    });
  });

  test("keeps one persisted hot-file-governance payload aligned across authenticated status, run history, and artifact APIs", async () => {
    const token = "test-token";
    const { config, fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });
    const timestamp = "2026-03-10T12-00-00-000Z";

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 4,
      last_error: "EvaluatorFailureLimit: repeated evaluator failures require operator review.",
      previous_hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
    });
    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "Hot-file governed summary\n",
      metrics: { round: 4, status: "failure" },
      evaluation: {
        decision: "fail",
        justification: "Hot-file governance blocked further growth.",
        evidence: ["bun test src/server.test.ts"],
        hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
      },
      log: "governed log\n",
      stateChange: "governed diff\n"
    });
    await saveEvaluation(paths, 4, {
      decision: "fail",
      justification: "Hot-file governance blocked further growth.",
      evidence: ["bun test src/server.test.ts"],
      hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
    });

    const [statusResponse, runsResponse, artifactsResponse] = await Promise.all([
      fetchHandler(createAuthorizedRequest("http://console.test/api/status", token)),
      fetchHandler(createAuthorizedRequest("http://console.test/api/runs?limit=1", token)),
      fetchHandler(createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token))
    ]);

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "paused",
      round: 4,
      hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
      operator_reason: {
        kind: "hot_file_governance",
        next_action: HOT_FILE_GOVERNANCE_PAYLOAD.recommended_next_action
      }
    });

    expect(runsResponse.status).toBe(200);
    expect(await runsResponse.json()).toEqual([
      expect.objectContaining({
        timestamp,
        round: 4,
        hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
        evaluation: expect.objectContaining({
          hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
        })
      })
    ]);

    expect(artifactsResponse.status).toBe(200);
    expect(await artifactsResponse.json()).toEqual(
      expect.objectContaining({
        timestamp,
        hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
        evaluation: expect.objectContaining({
          hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
        }),
        governance: {
          hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
          leader: null,
          ccb: null
        }
      })
    );

    expect(config.homeDir).toBe(paths.homeDir);
  });

  test("returns startup crash recovery signals when status finalizes a dead starting process", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      round: 5,
      state: "starting",
      pid: 999999
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 5,
      pid: null,
      pid_alive: false,
      operator_reason: {
        kind: "crash_recovery",
        title: "Crash recovery",
        summary: "Initialization was interrupted before normal round execution began.",
        next_action: "Inspect the run state and resume explicitly when safe.",
        severity: "critical"
      },
      crash_recovery: {
        interruption_type: "startup_interrupted",
        interrupted_state: "starting",
        recovered_by: "status_check",
        status_check_finalized: true,
        normal_round_execution_started: false,
        incomplete_work: false,
        reason: "process 999999 was not alive",
        summary: "Initialization was interrupted before normal round execution began.",
        next_action: "Inspect the run state and resume explicitly when safe."
      },
      last_error: expect.stringContaining("Crash recovery")
    });
  });

  test("returns round crash recovery signals when status finalizes a dead active round", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      round: 6,
      state: "running",
      pid: 999999,
      current_budget: {
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.3,
          actionsUsed: 7,
          elapsedMs: 8_000
        }
      }
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "paused",
      round: 6,
      pid: null,
      pid_alive: false,
      operator_reason: {
        kind: "crash_recovery",
        title: "Crash recovery",
        summary: "Round execution was interrupted during running; work may be incomplete.",
        next_action: "Inspect the run state and resume explicitly when safe.",
        severity: "critical"
      },
      crash_recovery: {
        interruption_type: "round_interrupted",
        interrupted_state: "running",
        recovered_by: "status_check",
        status_check_finalized: true,
        normal_round_execution_started: true,
        incomplete_work: true,
        reason: "process 999999 was not alive",
        summary: "Round execution was interrupted during running; work may be incomplete.",
        next_action: "Inspect the run state and resume explicitly when safe."
      },
      current_budget: {
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.3,
          actionsUsed: 7,
          elapsedMs: 8_000
        }
      },
      last_error: expect.stringContaining("Crash recovery")
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
        llmEvaluatorDimensions: ["constraint_compliance", "learning_yield"],
        llmEvaluatorMinPassScore: 88
      }
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/config", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ...(await readRuntimeLoopConfig(config)),
      aiRuntime: {
        bin: "codex",
        provider: "codex"
      }
    });
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
            bin: "/opt/homebrew/bin/claude",
            model: "claude-opus-4-6",
            profile: "saved-from-console"
          }
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      config: {
        ...(await readRuntimeLoopConfig(config)),
        aiRuntime: {
          bin: "/opt/homebrew/bin/claude",
          provider: "claude"
        }
      }
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
        bin: "/opt/homebrew/bin/claude",
        model: "claude-opus-4-6",
        profile: "saved-from-console"
      }
    });

    const db = new DatabaseManager({ dbPath: path.join(config.homeDir, "ailoop.db") });
    try {
      await expect(db.getConfig("AILOOP_AI_CLI_BIN")).resolves.toBe("/opt/homebrew/bin/claude");
      await expect(db.getConfig("AILOOP_AI_CLI_MODEL")).resolves.toBe("claude-opus-4-6");
      await expect(db.getConfig("AILOOP_AI_CLI_PROFILE")).resolves.toBe("saved-from-console");
      await expect(db.getConfig("AILOOP_AI_CLI_TIMEOUT_MS")).resolves.toBe(null);
    } finally {
      db.close();
    }
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
      }
    });

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/config/reset", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
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
          llmEvaluatorDimensions: [
            "goal_alignment",
            "causal_validity",
            "constraint_compliance",
            "risk_externality",
            "reversibility_resilience",
            "learning_yield"
          ],
          llmEvaluatorMinPassScore: 75
        },
        aiRuntime: {
          bin: "codex",
          provider: "codex"
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

    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "running",
      pid: process.pid
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

  test("rejects invalid authenticated pause requests without mutating persisted state", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const beforeState = await readLoopState(paths);

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/pause", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid control transition: pause is only allowed from starting, running, or cooldown.",
      code: "invalid_lifecycle_transition"
    });
    expect(await fs.stat(paths.pauseFlagPath).catch(() => null)).toBeNull();
    expect(await readLoopState(paths)).toEqual(beforeState);
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

  test("clears stale pause metadata from authenticated status responses after resume", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await fs.writeFile(paths.pauseFlagPath, "1\n", "utf8");
    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "paused",
      pid: process.pid,
      pause_reason: "Budget breach",
      last_error: "BudgetBreach: action budget exceeded",
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 2,
          actions: 10
        },
        usage: {
          usdUsed: 0.9,
          actionsUsed: 11,
          elapsedMs: 30_000
        }
      }
    });

    const resumeResponse = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/resume", token, {
        method: "POST"
      })
    );

    expect(resumeResponse.status).toBe(200);
    expect(await resumeResponse.json()).toEqual({ ok: true });

    const statusResponse = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "running",
      pid: process.pid,
      pid_alive: true,
      pause_reason: null,
      operator_reason: null,
      last_error: null,
      budget_health: null,
      current_budget: null
    });
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

  test("rejects invalid authenticated resume requests without mutating persisted state", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await fs.writeFile(paths.pauseFlagPath, "1\n", "utf8");
    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "running",
      pid: process.pid
    });

    const beforeState = await readLoopState(paths);

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/resume", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid control transition: resume is only allowed from paused.",
      code: "invalid_lifecycle_transition"
    });
    expect(await fs.readFile(paths.pauseFlagPath, "utf8")).toBe("1\n");
    expect(await readLoopState(paths)).toEqual(beforeState);
  });

  test("sets the stop flag for authenticated requests", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "running",
      pid: process.pid
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

  test("rejects invalid authenticated stop requests without mutating persisted state", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const beforeState = await readLoopState(paths);

    const response = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/stop", token, {
        method: "POST"
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid control transition: stop is only allowed from starting, running, cooldown, or paused.",
      code: "invalid_lifecycle_transition"
    });
    expect(await fs.stat(paths.stopFlagPath).catch(() => null)).toBeNull();
    expect(await readLoopState(paths)).toEqual(beforeState);
  });

  test("clears stale pause metadata from authenticated status responses after stop without a live pid", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    await fs.writeFile(paths.pauseFlagPath, "1\n", "utf8");
    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      pid: null,
      pause_reason: "Manual pause",
      last_error: "Waiting for review",
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

    const stopResponse = await fetchHandler(
      createAuthorizedRequest("http://console.test/api/loop/stop", token, {
        method: "POST"
      })
    );

    expect(stopResponse.status).toBe(200);
    expect(await stopResponse.json()).toEqual({ ok: true });

    const statusResponse = await fetchHandler(createAuthorizedRequest("http://console.test/api/status", token));

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "idle",
      pid: null,
      pid_alive: false,
      pause_reason: null,
      operator_reason: null,
      last_error: null,
      budget_health: null,
      current_budget: null
    });
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

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/runs?limit=2", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        timestamp: "2026-03-10T11-00-00-000Z",
        round: 0,
        summary: "Incomplete summary\n",
        metrics: null,
        evaluation: null,
        hot_file_governance: null,
        artifacts: {
          kind: "partial_bundle",
          label: "Partial bundle",
          present: ["log", "summary"],
          missing: ["metrics", "state_change", "evaluation"]
        },
        has_governance: false
      },
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
        hot_file_governance: null,
        artifacts: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
        },
        has_governance: false
      }
    ]);
  });

  test("returns hot-file governance metadata in authenticated run history responses", async () => {
    const token = "test-token";
    const { config, fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const hotFileGovernance = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
      result_class: "hot_file_growth_failure",
      reason: "continued growth in pressured file without bounded justification",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    await writeRunArtifacts(paths.runsDir, "2026-03-10T12-00-00-000Z", {
      summary: "Hot-file governed summary\n",
      metrics: { round: 4, status: "failure" },
      evaluation: {
        decision: "fail",
        justification: "Hot-file governance blocked further growth.",
        evidence: ["bun test src/server.test.ts"],
        hot_file_governance: hotFileGovernance
      },
      log: "governed log\n",
      stateChange: "governed diff\n"
    });
    await seedRoundHistory(config.homeDir, {
      round: 4,
      timestamp: "2026-03-10T12-00-00-000Z",
      state: "paused",
      decision: "fail",
      justification: "Hot-file governance blocked further growth.",
      hotFileGovernance
    });

    const response = await fetchHandler(createAuthorizedRequest("http://console.test/api/runs?limit=1", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        timestamp: "2026-03-10T12-00-00-000Z",
        round: 4,
        summary: "Hot-file governed summary\n",
        metrics: {
          round: 4,
          status: "failure"
        },
        evaluation: {
          decision: "fail",
          justification: "Hot-file governance blocked further growth.",
          evidence: ["bun test src/server.test.ts"],
          hot_file_governance: hotFileGovernance
        },
        hot_file_governance: hotFileGovernance,
        artifacts: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
        },
        has_governance: true
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
        hot_file_governance: null,
        artifacts: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
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
      hot_file_governance: null,
      log: "OPENAI_API_KEY=[REDACTED]\n",
      state_change: "+SESSION_SECRET=[REDACTED]\n",
      artifacts: {
        kind: "full_bundle",
        label: "Full evidence bundle",
        present: ["log", "summary", "metrics", "state_change", "evaluation"],
        missing: []
      },
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
        hot_file_governance: null,
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
      hot_file_governance: null,
      log: "round log\n",
      state_change: "+state change\n",
      artifacts: {
        kind: "full_bundle",
        label: "Full evidence bundle",
        present: ["log", "summary", "metrics", "state_change", "evaluation"],
        missing: []
      },
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
        hot_file_governance: null,
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

  test("returns hot-file governance in both artifact and governance payloads for selected runs", async () => {
    const token = "test-token";
    const { config, fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const timestamp = "2026-03-10T11-30-00-000Z";
    const hotFileGovernance = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
      result_class: "hot_file_growth_failure",
      reason: "continued growth in pressured file without bounded justification",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "Hot-file artifact summary\n",
      metrics: { round: 5, status: "failure" },
      evaluation: {
        decision: "fail",
        justification: "Hot-file governance blocked the round.",
        evidence: ["bun test src/server.test.ts"],
        hot_file_governance: hotFileGovernance
      },
      log: "artifact log\n",
      stateChange: "artifact diff\n"
    });
    await seedRoundHistory(config.homeDir, {
      round: 5,
      timestamp,
      state: "paused",
      decision: "fail",
      justification: "Hot-file governance blocked the round.",
      hotFileGovernance
    });

    const [artifactsResponse, governanceResponse] = await Promise.all([
      fetchHandler(createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token)),
      fetchHandler(createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/governance`, token))
    ]);

    expect(artifactsResponse.status).toBe(200);
    expect(await artifactsResponse.json()).toEqual({
      timestamp,
      summary: "Hot-file artifact summary\n",
      metrics: {
        round: 5,
        status: "failure"
      },
      evaluation: {
        decision: "fail",
        justification: "Hot-file governance blocked the round.",
        evidence: ["bun test src/server.test.ts"],
        hot_file_governance: hotFileGovernance
      },
      hot_file_governance: hotFileGovernance,
      log: "artifact log\n",
      state_change: "artifact diff\n",
      artifacts: {
        kind: "full_bundle",
        label: "Full evidence bundle",
        present: ["log", "summary", "metrics", "state_change", "evaluation"],
        missing: []
      },
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
        hot_file_governance: hotFileGovernance,
        leader: null,
        ccb: null
      }
    });

    expect(governanceResponse.status).toBe(200);
    expect(await governanceResponse.json()).toEqual({
      hot_file_governance: hotFileGovernance,
      leader: null,
      ccb: null
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
      hot_file_governance: null,
      log: "sessionSecret=[REDACTED]\n",
      state_change: "+apiToken=[REDACTED]\n",
      artifacts: {
        kind: "full_bundle",
        label: "Full evidence bundle",
        present: ["log", "summary", "metrics", "state_change", "evaluation"],
        missing: []
      },
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
        hot_file_governance: null,
        leader: null,
        ccb: null
      }
    });
  });

  test("returns partial run artifact bundles with explicit missing-artifact metadata", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const timestamp = "2026-03-10T10-45-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "Partial summary\n",
      metrics: { round: 4, status: "running" },
      log: "partial log\n"
    });

    const response = await fetchHandler(
      createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timestamp,
      summary: "Partial summary\n",
      metrics: {
        round: 4,
        status: "running"
      },
      evaluation: null,
      hot_file_governance: null,
      log: "partial log\n",
      state_change: null,
      artifacts: {
        kind: "partial_bundle",
        label: "Partial bundle",
        present: ["log", "summary", "metrics"],
        missing: ["state_change", "evaluation"]
      },
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
        hot_file_governance: null,
        leader: null,
        ccb: null
      }
    });
  });

  test("returns log-only run artifact bundles instead of 404", async () => {
    const token = "test-token";
    const { fetchHandler, paths } = await createFixture({
      consoleAdminToken: token
    });

    const timestamp = "2026-03-10T10-50-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      log: "log only\n"
    });

    const response = await fetchHandler(
      createAuthorizedRequest(`http://console.test/api/runs/${timestamp}/artifacts`, token)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timestamp,
      summary: null,
      metrics: null,
      evaluation: null,
      hot_file_governance: null,
      log: "log only\n",
      state_change: null,
      artifacts: {
        kind: "log_only",
        label: "Log only",
        present: ["log"],
        missing: ["summary", "metrics", "state_change", "evaluation"]
      },
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
