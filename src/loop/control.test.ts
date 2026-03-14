import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { buildLoopPaths, defaultLoopState, hasFlag, readLoopState, setFlag, writeLoopState } from "./state";
import {
  ensureProjectRoles,
  getCliStatus,
  getLoopStatus,
  getRunArtifacts,
  listRuns,
  listProjectRoles,
  prepareStartFlags,
  resumeLoop,
  startBackgroundLoop,
  tailLatestLog
} from "./control";
import type { AppConfig } from "../config/env";
import { saveRuntimeLoopConfig } from "../config/runtime";
import { writeActiveRequirementArtifact } from "../product/requirements";

function makeTestConfig(homeDir: string): AppConfig {
  return {
    homeDir,
    intervalSeconds: 1,
    maxCycles: 0,
    exitOnError: false,
    evaluatorReworkMaxAttempts: 1,
    consoleHost: "127.0.0.1",
    consolePort: 3090,
    consoleAdminToken: "",
    maxRetainRuns: 10,
    budget: {
      usdPerRound: 1,
      timeMinutes: 1,
      actions: 10
    },
    enableLeader: false,
    codex: {
      bin: "codex",
      model: "",
      profile: "",
      plannerSandbox: "read-only",
      executorSandbox: "danger-full-access",
      evaluatorSandbox: "danger-full-access",
      timeoutMs: 1000,
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

async function waitForRunningState(homeDir: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  const paths = buildLoopPaths(homeDir);

  while (Date.now() < deadline) {
    const state = await readLoopState(paths);
    if (state.state === "running" && state.pid) {
      return state;
    }
    await Bun.sleep(25);
  }

  throw new Error("Timed out waiting for loop state running");
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

function makeSpawnResult(pid: number): ReturnType<typeof childProcess.spawn> {
  return {
    pid,
    unref() {}
  } as ReturnType<typeof childProcess.spawn>;
}

function makeSpawnMock(nextPid: () => number): typeof childProcess.spawn {
  return ((..._args: Parameters<typeof childProcess.spawn>) =>
    makeSpawnResult(nextPid())) as typeof childProcess.spawn;
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

describe("prepareStartFlags", () => {
  test("clears both stop and pause flags before start", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-test-"));
    const paths = buildLoopPaths(homeDir);

    await setFlag(paths.stopFlagPath);
    await setFlag(paths.pauseFlagPath);
    expect(await hasFlag(paths.stopFlagPath)).toBe(true);
    expect(await hasFlag(paths.pauseFlagPath)).toBe(true);

    await prepareStartFlags(paths);

    expect(await hasFlag(paths.stopFlagPath)).toBe(false);
    expect(await hasFlag(paths.pauseFlagPath)).toBe(false);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("startBackgroundLoop", () => {
  test("collapses duplicate concurrent starts into a single background start", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-start-duplicate-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = buildLoopPaths(homeDir);
    const originalCwd = process.cwd();
    let nextPid = 80_000;

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
    await seedProjectRoles(paths);

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(makeSpawnMock(() => nextPid++));

    try {
      process.chdir(workspaceRoot);

      const [first, second] = await Promise.all([
        startBackgroundLoop(makeTestConfig(homeDir)),
        startBackgroundLoop(makeTestConfig(homeDir))
      ]);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(first).toEqual({
        started: true,
        message: "Loop started with pid 80000"
      });
      expect(second).toEqual(first);

      const state = await readLoopState(paths);
      expect(state.state).toBe("starting");
      expect(state.pid).toBe(80_000);
    } finally {
      process.chdir(originalCwd);
      mock.restore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("ignores invalid persisted non-positive pids and starts a fresh background loop", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-start-invalid-pid-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = buildLoopPaths(homeDir);
    const originalCwd = process.cwd();
    let nextPid = 81_000;

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
    await seedProjectRoles(paths);
    await fs.writeFile(paths.pidPath, "0\n", "utf8");
    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "running",
      pid: -1
    });

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(makeSpawnMock(() => nextPid++));

    try {
      process.chdir(workspaceRoot);

      const result = await startBackgroundLoop(makeTestConfig(homeDir));

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        started: true,
        message: "Loop started with pid 81000"
      });

      const state = await readLoopState(paths);
      expect(state.state).toBe("starting");
      expect(state.pid).toBe(81_000);
    } finally {
      process.chdir(originalCwd);
      mock.restore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("tailLatestLog", () => {
  test("returns tail from newest round log even when round artifacts are incomplete", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-tail-test-"));
    const runsDir = path.join(homeDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });

    await fs.writeFile(path.join(runsDir, "2026-03-01T01-00-00-000Z.round.log"), "older-1\nolder-2\n", "utf8");
    await fs.writeFile(
      path.join(runsDir, "2026-03-01T02-00-00-000Z.round.log"),
      "newer-1\nnewer-2\nnewer-3\n",
      "utf8"
    );

    const lines = await tailLatestLog(makeTestConfig(homeDir), 2);
    expect(lines).toEqual(["newer-2", "newer-3"]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("redacts secret-like values from the newest round log tail", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-tail-redaction-test-"));
    const runsDir = path.join(homeDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });

    await fs.writeFile(
      path.join(runsDir, "2026-03-01T03-00-00-000Z.round.log"),
      "visible-line\nsessionSecret=uniquesecret123\napiToken=anothersecret456!\n",
      "utf8"
    );

    const lines = await tailLatestLog(makeTestConfig(homeDir), 3);
    expect(lines).toEqual(["visible-line", "sessionSecret=[REDACTED]", "apiToken=[REDACTED]!"]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("listRuns", () => {
  test("returns null evaluation when the evaluation artifact is missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-list-runs-test-"));
    const runsDir = path.join(homeDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });

    const timestamp = "2026-03-01T02-00-00-000Z";
    await fs.writeFile(path.join(runsDir, `${timestamp}.round.summary.md`), "summary\n", "utf8");
    await fs.writeFile(
      path.join(runsDir, `${timestamp}.round.metrics.json`),
      `${JSON.stringify({ round: 2, status: "success" }, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(path.join(runsDir, `${timestamp}.round.log`), "log\n", "utf8");
    await fs.writeFile(path.join(runsDir, `${timestamp}.round.state_change.txt`), "diff\n", "utf8");

    const runs = await listRuns(makeTestConfig(homeDir));
    expect(runs).toEqual([
      {
        timestamp,
        round: 2,
        summary: "summary\n",
        metrics: {
          round: 2,
          status: "success"
        },
        evaluation: null
      }
    ]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("prefers the structured evaluation artifact over truncated database history", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-list-runs-structured-eval-test-"));
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T03-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      summary: "summary\n",
      metrics: { round: 4, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Structured evaluation payload from artifact.",
        evidence: ["bun test src/loop/control.test.ts"],
        aggregate_score: 97,
        recommended_next_action: "continue",
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "pass",
            score: 99,
            confidence: 0.91,
            justification: "The richer evaluation payload is preserved.",
            evidence: ["artifact evidence"],
            blocking_issues: [],
            recommended_next_action: "continue"
          }
        ]
      },
      log: "log\n",
      stateChange: "diff\n"
    });

    await seedRoundHistory(homeDir, {
      round: 4,
      timestamp,
      decision: "pass",
      justification: "Database summary should not override the artifact.",
      rootCause: "db_only_summary",
      dimensions: [
        {
          dimension: "goal_alignment",
          decision: "pass",
          justification: "Truncated DB dimension"
        }
      ]
    });

    try {
      const runs = await listRuns(makeTestConfig(homeDir));

      expect(runs).toEqual([
        {
          timestamp,
          round: 4,
          summary: "summary\n",
          metrics: {
            round: 4,
            status: "success"
          },
          evaluation: {
            decision: "pass",
            justification: "Structured evaluation payload from artifact.",
            evidence: ["bun test src/loop/control.test.ts"],
            aggregate_score: 97,
            recommended_next_action: "continue",
            dimensions: [
              {
                dimension: "goal_alignment",
                decision: "pass",
                score: 99,
                confidence: 0.91,
                justification: "The richer evaluation payload is preserved.",
                evidence: ["artifact evidence"],
                blocking_issues: [],
                recommended_next_action: "continue"
              }
            ]
          }
        }
      ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("redacts secret-like values from summaries and structured evaluations", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-list-runs-redaction-test-"));
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T04-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      summary: "summary sessionSecret=uniquesecret123\n",
      metrics: { round: 5, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Validated apiToken=uniquesecret123.",
        evidence: ["sessionSecret=uniquesecret123"],
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "pass",
            score: 98,
            confidence: 0.92,
            justification: "Nested apiToken=uniquesecret123 stayed visible.",
            evidence: ["sessionSecret=uniquesecret123"],
            blocking_issues: [],
            recommended_next_action: "continue"
          }
        ]
      },
      log: "log\n",
      stateChange: "diff\n"
    });

    try {
      const runs = await listRuns(makeTestConfig(homeDir));

      expect(runs).toEqual([
        {
          timestamp,
          round: 5,
          summary: "summary sessionSecret=[REDACTED]\n",
          metrics: {
            round: 5,
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
                confidence: 0.92,
                justification: "Nested apiToken=[REDACTED] stayed visible.",
                evidence: ["sessionSecret=[REDACTED]"],
                blocking_issues: [],
                recommended_next_action: "continue"
              }
            ]
          }
        }
      ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("getRunArtifacts", () => {
  test("returns the full artifact bundle for a specific completed run", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-test-"));
    const paths = buildLoopPaths(homeDir);
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T02-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      summary: "summary\n",
      metrics: { round: 2, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified.",
        evidence: ["bun test src/loop/control.test.ts"]
      },
      log: "OPENAI_API_KEY=[REDACTED]\n",
      stateChange: "+ SESSION_SECRET=[REDACTED]\n"
    });

    const artifacts = await getRunArtifacts(makeTestConfig(homeDir), timestamp);

    expect(artifacts).toEqual({
      timestamp,
      summary: "summary\n",
      metrics: {
        round: 2,
        status: "success"
      },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified.",
        evidence: ["bun test src/loop/control.test.ts"]
      },
      log: "OPENAI_API_KEY=[REDACTED]\n",
      state_change: "+ SESSION_SECRET=[REDACTED]\n",
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
      }
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("includes the active requirement snapshot alongside the run artifact bundle", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-requirement-test-"));
    const paths = buildLoopPaths(homeDir);
    const timestamp = "2026-03-01T02-00-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      summary: "summary\n",
      metrics: { round: 2, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified.",
        evidence: ["bun test src/loop/control.test.ts"]
      },
      log: "round log\n",
      stateChange: "state diff\n"
    });
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Operator Visibility",
        "",
        "## Problem",
        "Operators need a readable requirement snapshot in the control plane.",
        "",
        "## Acceptance Criteria",
        "- The status API exposes the active requirement summary.",
        "- The run artifact bundle exposes the active requirement snapshot.",
        "",
        "## Lifecycle Status",
        "- Status: complete",
        "- Completed In Round: 4",
        "- Completion Reason: All acceptance criteria matched.",
        "- Matched Acceptance Criteria: 2",
        "- Remaining Acceptance Criteria: 0"
      ].join("\n")
    );

    const artifacts = await getRunArtifacts(makeTestConfig(homeDir), timestamp);

    expect(artifacts).toEqual({
      timestamp,
      summary: "summary\n",
      metrics: {
        round: 2,
        status: "success"
      },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified.",
        evidence: ["bun test src/loop/control.test.ts"]
      },
      log: "round log\n",
      state_change: "state diff\n",
      active_requirement: {
        path: paths.activeRequirementPath,
        exists: true,
        artifact_status: "needs_refresh",
        lifecycle_status: "complete",
        title: "Requirement Slice: Operator Visibility",
        summary: "Operators need a readable requirement snapshot in the control plane.",
        acceptance_criteria_total: 2,
        acceptance_criteria_completed: 2,
        markdown: expect.stringContaining("# Requirement Slice: Operator Visibility"),
        updated_at: expect.any(String)
      }
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("redacts mixed-case secret assignments from archived run artifacts at serve time", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-redaction-test-"));
    const paths = buildLoopPaths(homeDir);
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T03-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      summary: "summary sessionSecret=uniquesecret123\n",
      metrics: { round: 3, status: "success" },
      evaluation: {
        decision: "pass",
        justification: "Artifacts verified for apiToken=uniquesecret123.",
        evidence: ["sessionSecret=uniquesecret123"]
      },
      log: "sessionSecret=uniquesecret123\n",
      stateChange: "+ apiToken=uniquesecret123\n"
    });

    try {
      const artifacts = await getRunArtifacts(makeTestConfig(homeDir), timestamp);

      expect(artifacts).toEqual({
        timestamp,
        summary: "summary sessionSecret=[REDACTED]\n",
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
        state_change: "+ apiToken=[REDACTED]\n",
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
        }
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("returns null for timestamps without a complete artifact bundle", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-missing-test-"));
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T02-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      summary: "summary\n",
      metrics: { round: 2, status: "success" },
      log: "log\n",
      stateChange: "diff\n"
    });

    expect(await getRunArtifacts(makeTestConfig(homeDir), timestamp)).toBeNull();
    expect(await getRunArtifacts(makeTestConfig(homeDir), "../outside")).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("resumeLoop", () => {
  test("clears pause flag and immediately marks paused loops as running", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-resume-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await setFlag(paths.pauseFlagPath);
    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "paused",
      pid: process.pid
    });

    await resumeLoop(makeTestConfig(homeDir));

    expect(await hasFlag(paths.pauseFlagPath)).toBe(false);
    const state = await readLoopState(paths);
    expect(state.state).toBe("running");
    expect(state.pid).toBe(process.pid);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("restarts a paused loop when no live pid exists", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-resume-restart-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = buildLoopPaths(homeDir);
    const originalCwd = process.cwd();

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
    await seedProjectRoles(paths);
    await seedLoopEntrypoint(workspaceRoot);
    await setFlag(paths.pauseFlagPath);
    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      pid: null
    });

    let restartedPid: number | null = null;
    try {
      process.chdir(workspaceRoot);

      await resumeLoop(makeTestConfig(homeDir));

      expect(await hasFlag(paths.pauseFlagPath)).toBe(false);

      const state = await readLoopState(paths);
      expect(state.state).toBe("starting");
      expect(state.pid).not.toBeNull();
      restartedPid = state.pid;

      const runningState = await waitForRunningState(homeDir);
      expect(runningState.pid).toBe(restartedPid);
      expect(runningState.last_error).toBeNull();
    } finally {
      process.chdir(originalCwd);
      killIfAlive(restartedPid);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("collapses duplicate concurrent resumes into a single background start", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-resume-duplicate-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = buildLoopPaths(homeDir);
    const originalCwd = process.cwd();
    let nextPid = 70_000;

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
    await seedProjectRoles(paths);
    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      pid: null
    });

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(makeSpawnMock(() => nextPid++));

    try {
      process.chdir(workspaceRoot);

      await Promise.all([resumeLoop(makeTestConfig(homeDir)), resumeLoop(makeTestConfig(homeDir))]);

      expect(spawnSpy).toHaveBeenCalledTimes(1);

      const state = await readLoopState(paths);
      expect(state.state).toBe("starting");
      expect(state.pid).toBe(70_000);
      expect(await hasFlag(paths.pauseFlagPath)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      mock.restore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("getLoopStatus", () => {
  test("includes a safe active requirement summary in loop status", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-requirement-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 3
    });
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Console Health",
        "",
        "## Problem",
        "Operators need the console to reveal the active requirement at a glance.",
        "",
        "## Acceptance Criteria",
        "- The status API includes the active requirement summary.",
        "- The console can open the full requirement markdown."
      ].join("\n")
    );

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status).toMatchObject({
      state: "paused",
      round: 3,
      pid_alive: false,
      active_requirement: {
        path: paths.activeRequirementPath,
        exists: true,
        artifact_status: "ready",
        lifecycle_status: "active",
        title: "Requirement Slice: Console Health",
        summary: "Operators need the console to reveal the active requirement at a glance.",
        acceptance_criteria_total: 2,
        acceptance_criteria_completed: 0,
        markdown: expect.stringContaining("# Requirement Slice: Console Health")
      }
    });
    expect(status.active_requirement.updated_at).toEqual(expect.any(String));

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("marks a dead starting process as paused and preserves interrupted start context", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-starting-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    const staleState = {
      ...defaultLoopState(),
      round: 4,
      state: "starting" as const,
      pid: 999999
    };
    await writeLoopState(paths, staleState);

    const status = await getLoopStatus(makeTestConfig(homeDir));
    expect(status.state).toBe("paused");
    expect(status.round).toBe(4);
    expect(status.pid).toBeNull();
    expect(status.pid_alive).toBe(false);
    expect(status.last_error).toContain("unfinished starting state");
    expect(status.last_error).toContain("during status check");

    const persisted = await readLoopState(paths);
    expect(persisted.state).toBe("paused");
    expect(persisted.round).toBe(4);
    expect(persisted.pid).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("marks a dead cooldown process as paused and preserves interrupted round context", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-cooldown-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    const staleState = {
      ...defaultLoopState(),
      round: 3,
      state: "cooldown" as const,
      pid: 999999,
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 1,
          actions: 10
        },
        usage: {
          usdUsed: 0.4,
          actionsUsed: 4,
          elapsedMs: 20_000
        }
      }
    };
    await writeLoopState(paths, staleState);

    const status = await getLoopStatus(makeTestConfig(homeDir));
    expect(status.state).toBe("paused");
    expect(status.round).toBe(3);
    expect(status.pid).toBeNull();
    expect(status.pid_alive).toBe(false);
    expect(status.current_budget).toEqual(staleState.current_budget);
    expect(status.last_error).toContain("during status check");
    expect(status.last_error).toContain("process 999999 was not alive");

    const persisted = await readLoopState(paths);
    expect(persisted.state).toBe("paused");
    expect(persisted.round).toBe(3);
    expect(persisted.pid).toBeNull();
    expect(persisted.current_budget).toEqual(staleState.current_budget);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("clears stale budget snapshot when loop is idle", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-idle-budget-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "idle",
      pid: null,
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 1,
          actions: 10
        },
        usage: {
          usdUsed: 0.3,
          actionsUsed: 2,
          elapsedMs: 45_000
        }
      }
    });

    const status = await getLoopStatus(makeTestConfig(homeDir));
    expect(status.state).toBe("idle");
    expect(status.current_budget).toBeNull();

    const persisted = await readLoopState(paths);
    expect(persisted.current_budget).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("getCliStatus", () => {
  test("returns runtime budget limits alongside loop state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-cli-status-test-"));
    await fs.mkdir(homeDir, { recursive: true });
    const config = makeTestConfig(homeDir);

    await saveRuntimeLoopConfig(config, {
      ...config,
      budget: {
        usdPerRound: 7.25,
        timeMinutes: 22,
        actions: 44
      }
    });

    const status = await getCliStatus(config);
    expect(status.state.state).toBe("idle");
    expect(status.budget).toEqual({
      usdPerRound: 7.25,
      timeMinutes: 22,
      actions: 44
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("ensureProjectRoles", () => {
  test("creates project role files when they are missing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-roles-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Example\n\nService project", "utf8");

    const mockCodex = {
      async runJson<T>() {
        return {
          ok: true,
          data: {
            planner_role_md: "# Planner Role\n\nGenerated",
            product_manager_role_md: "# Product Manager Role\n\nGenerated",
            executor_role_md: "# Executor Role\n\nGenerated",
            evaluator_role_md: "# Evaluator Role\n\nGenerated",
            leader_role_md: "# Leader Role\n\nGenerated",
            designer_role_md: "# Designer Role\n\nGenerated",
            senior_dev_role_md: "# Senior Dev Role\n\nGenerated",
            qa_lead_role_md: "# QA Lead Role\n\nGenerated",
            product_owner_role_md: "# Product Owner Role\n\nGenerated"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    await ensureProjectRoles(makeTestConfig(homeDir), {
      workspaceRoot,
      regen: false,
      codexClient: mockCodex as never
    });

    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("Generated");
    expect(await fs.readFile(path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"), "utf8")).toContain("Generated");
    expect(await fs.readFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "utf8")).toContain("Generated");
    expect(await fs.readFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "utf8")).toContain("Generated");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});

describe("listProjectRoles", () => {
  test("returns role metadata and markdown for the current project", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-list-roles-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner\n", "utf8");
    await fs.writeFile(path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"), "# Product Manager Role\n\nCustom product manager\n", "utf8");
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nCustom executor\n", "utf8");

    const roles = await listProjectRoles(makeTestConfig(homeDir));

    expect(roles.length).toBe(4);
    expect(roles.map((role) => role.role)).toEqual(["planner", "product_manager", "executor", "evaluator"]);
    expect(roles[0]?.title).toBe("Project Planner");
    expect(roles[1]?.title).toBe("Product Manager");
    expect(roles[0]?.definition).toContain("Custom planner");
    expect(roles[1]?.definition).toContain("Custom product manager");
    expect(roles[2]?.definition).toContain("Custom executor");
    expect(roles[3]?.definition).toContain("Project Evaluator Role");
    expect(typeof roles[3]?.exists).toBe("boolean");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});
