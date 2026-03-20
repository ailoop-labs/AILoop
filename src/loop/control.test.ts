import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  appendInstruction,
  buildLoopPaths,
  defaultLoopState,
  hasFlag,
  readLoopState,
  saveEvaluation,
  setFlag,
  writeLoopState
} from "./state";
import {
  ensureProjectRoles,
  getCliStatus,
  getLoopStatus,
  getRunArtifacts,
  InvalidExternalValidationBaselineRunsDirError,
  listRuns,
  listProjectRoles,
  pauseLoop,
  prepareStartFlags,
  renderCliStatus,
  resolveStartedLoopState,
  resumeLoop,
  runExternalValidationMetricsReport,
  startBackgroundLoop,
  stopLoop,
  tailLatestLog
} from "./control";
import type { AppConfig } from "../config/env";
import { saveRuntimeLoopConfig } from "../config/runtime";
import { writeActiveRequirementArtifact } from "../product/requirements";
import { buildRoundSubTaskIdentity } from "../reporting/metrics";
import { writeSummaryFile } from "../reporting/summary";

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

function runCommand(command: string, cwd: string): void {
  childProcess.execSync(command, {
    cwd,
    stdio: "pipe"
  });
}

function runAiloopCli(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const processResult = Bun.spawnSync({
    cmd: ["bun", "run", "/Users/yinjames/projects/AILoop/scripts/ailoop.ts", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: processResult.exitCode,
    stdout: new TextDecoder().decode(processResult.stdout).trim(),
    stderr: new TextDecoder().decode(processResult.stderr).trim()
  };
}

async function createExternalValidationCandidate(options?: {
  initializeGit?: boolean;
  includeTestInfrastructure?: boolean;
  dependencyCount?: number;
}): Promise<string> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-"));
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
    runCommand("git init", repoDir);
  }

  return repoDir;
}

// Compact contract payload reused to verify status, run-history, and artifact views stay aligned.
const HOT_FILE_GOVERNANCE_PAYLOAD = {
  file_path: "src/loop/engine.ts",
  heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
  result_class: "hot_file_growth_failure" as const,
  reason: "continued growth in pressured file without bounded justification",
  recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
};

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

function makePersistedRoundMetrics(input: {
  round: number;
  run_timestamp: string;
  evaluator_decision: "pass" | "fail";
  human_interventions: number;
  hot_file_growth_lines: number;
  usdUsed?: number;
  actionsUsed?: number;
  actionLimit?: number;
  sub_task_identity?: ReturnType<typeof buildRoundSubTaskIdentity>;
}): Record<string, unknown> {
  return {
    round: input.round,
    run_timestamp: input.run_timestamp,
    duration_ms: 1_000,
    budget_limits: {
      usdPerRound: 1,
      timeMinutes: 1,
      actions: input.actionLimit ?? 10
    },
    budget_usage: {
      usdUsed: input.usdUsed ?? 0.1,
      elapsedMs: 500,
      actionsUsed: input.actionsUsed ?? 2
    },
    evaluator_decision: input.evaluator_decision,
    tool_status: "success",
    retries: {
      evidence_remediation_attempts: 0,
      auto_rework_attempts: 0,
      auto_rework_limit: 1
    },
    phase_timings_ms: {
      planning: 100,
      execution: 200,
      evaluation: 300,
      operational_followup: 50
    },
    human_interventions: input.human_interventions,
    hot_file_growth_lines: input.hot_file_growth_lines,
    ...(input.sub_task_identity ? { sub_task_identity: input.sub_task_identity } : {})
  };
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

describe("pauseLoop", () => {
  test("fails clearly without mutating state or flags when the loop is idle", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-pause-invalid-idle-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    const beforeState = await readLoopState(paths);

    await expect(pauseLoop(config)).rejects.toThrow("Invalid control transition: pause is only allowed from starting, running, or cooldown.");

    expect(await hasFlag(paths.pauseFlagPath)).toBe(false);
    expect(await readLoopState(paths)).toEqual(beforeState);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("startBackgroundLoop", () => {
  test("preserves a newer running state for the same child pid when start bookkeeping lags behind", () => {
    const latestState = {
      ...defaultLoopState(),
      state: "running" as const,
      pid: 81_234,
      last_error: "executor already updated the state",
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 2,
          actions: 10
        },
        usage: {
          usdUsed: 0.1,
          elapsedMs: 2_000,
          actionsUsed: 3
        }
      }
    };

    expect(resolveStartedLoopState(latestState, 81_234)).toEqual(latestState);
  });

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

  test("opens a dedicated background loop log file and redirects stdout/stderr into it", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-start-log-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = buildLoopPaths(homeDir);
    const originalCwd = process.cwd();
    let nextPid = 82_000;

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
    await seedProjectRoles(paths);

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(makeSpawnMock(() => nextPid++));

    try {
      process.chdir(workspaceRoot);

      await startBackgroundLoop(makeTestConfig(homeDir));

      await expect(fs.stat(paths.loopLogPath)).resolves.toBeDefined();
      const spawnOptions = spawnSpy.mock.calls[0]?.[2];
      expect(spawnOptions).toBeDefined();
      expect(Array.isArray(spawnOptions?.stdio)).toBe(true);
      expect(spawnOptions?.stdio?.[0]).toBe("ignore");
      expect(typeof spawnOptions?.stdio?.[1]).toBe("number");
      expect(typeof spawnOptions?.stdio?.[2]).toBe("number");
    } finally {
      process.chdir(originalCwd);
      mock.restore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("injects DB-backed AI CLI variables into the background loop environment", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-start-ai-env-test-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = buildLoopPaths(homeDir);
    const originalCwd = process.cwd();

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Test workspace\n", "utf8");
    await seedProjectRoles(paths);

    await saveRuntimeLoopConfig(makeTestConfig(homeDir), {
      intervalSeconds: 90,
      codex: {
        bin: "/opt/homebrew/bin/claude",
        model: "claude-opus-4-6"
      }
    });

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(makeSpawnMock(() => 83_000));

    try {
      process.chdir(workspaceRoot);

      await startBackgroundLoop(makeTestConfig(homeDir));

      const spawnOptions = spawnSpy.mock.calls[0]?.[2];
      expect(spawnOptions?.env?.AILOOP_AI_CLI_BIN).toBe("/opt/homebrew/bin/claude");
      expect(spawnOptions?.env?.AILOOP_AI_CLI_MODEL).toBe("claude-opus-4-6");
      expect(spawnOptions?.env?.AILOOP_AI_CLI_TIMEOUT_MS).toBe("1800000");
      expect(spawnOptions?.env?.AILOOP_CODEX_BIN).toBeUndefined();
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
        evaluation: null,
        hot_file_governance: null,
        artifacts: {
          kind: "partial_bundle",
          label: "Partial bundle",
          present: ["log", "summary", "metrics", "state_change"],
          missing: ["evaluation"]
        }
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
        },
        hot_file_governance: null,
        artifacts: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
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
        },
        hot_file_governance: null,
        artifacts: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
        }
      }
    ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("includes log-only runs in history with explicit artifact metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-list-runs-log-only-test-"));
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T05-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      log: "log only\n"
    });

    try {
      const runs = await listRuns(makeTestConfig(homeDir));

      expect(runs).toEqual([
        {
          timestamp,
          round: 0,
          summary: "",
          metrics: null,
          evaluation: null,
          hot_file_governance: null,
          artifacts: {
            kind: "log_only",
            label: "Log only",
            present: ["log"],
            missing: ["summary", "metrics", "state_change", "evaluation"]
          }
        }
      ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("keeps paused auto-rework evidence intact in structured run history summaries", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-list-runs-paused-rework-history-test-"));
    const paths = buildLoopPaths(homeDir);
    const timestamp = "2026-03-20T08-00-00-000Z";
    const summaryPath = path.join(paths.runsDir, `${timestamp}.round.summary.md`);

    await fs.mkdir(paths.runsDir, { recursive: true });
    await writeSummaryFile(summaryPath, {
      goal: "Preserve paused rework history",
      subTask: {
        assignee: "executor",
        rationale: "test rationale",
        objective: "Keep paused rework evidence visible",
        expected_outcome: "history still shows both rework attempts after pause",
        impacted_files: [],
        recommended_tools: ["read_file", "write_file", "run_shell"]
      },
      actions: [],
      toolResult: {
        status: "success",
        summary: "Applied the second rework patch",
        operational_evidence: [],
        artifacts: {
          log_path: path.join(paths.runsDir, `${timestamp}.round.log`),
          state_change_path: path.join(paths.runsDir, `${timestamp}.round.state_change.txt`)
        },
        error: undefined,
        next_state_hint: "continue"
      },
      evaluation: {
        decision: "fail",
        justification: "Evaluator still rejected the paused history path.",
        evidence: ["bun test src/loop/engine.test.ts"],
        recommended_next_action: "Inspect the evaluator findings and narrow the next sub-task before resuming."
      },
      metrics: {
        round: 7,
        run_timestamp: timestamp.replace(/-/g, ":").replace(/:(\d{3})Z$/, ".$1Z"),
        duration_ms: 5_000,
        budget_limits: {
          usdPerRound: 1,
          timeMinutes: 1,
          actions: 10
        },
        budget_usage: {
          usdUsed: 0.4,
          actionsUsed: 5,
          elapsedMs: 5_000
        },
        evaluator_decision: "fail",
        tool_status: "success",
        retries: {
          evidence_remediation_attempts: 0,
          auto_rework_attempts: 2,
          auto_rework_limit: 2
        },
        phase_timings_ms: {
          planning: 100,
          execution: 1_700,
          evaluation: 900,
          operational_followup: 0
        },
        failure_mode: "execution_failure"
      },
      stateChange: "No state changes detected.\n",
      risks: [],
      autoReworkAttempts: [
        "Attempt 1/2: trigger='Missing rollback coverage for the paused path.' evaluation=fail",
        "Attempt 2/2: trigger='History still drops the first rework attempt.' evaluation=fail"
      ],
      nextRecommendation: "Inspect the evaluator findings and narrow the next sub-task before resuming."
    });
    await fs.writeFile(path.join(paths.runsDir, `${timestamp}.round.metrics.json`), '{\n  "round": 7\n}\n', "utf8");
    await fs.writeFile(path.join(paths.runsDir, `${timestamp}.round.log`), "log\n", "utf8");
    await fs.writeFile(path.join(paths.runsDir, `${timestamp}.round.state_change.txt`), "diff\n", "utf8");
    await fs.writeFile(
      path.join(paths.runsDir, `${timestamp}.round.evaluation.json`),
      `${JSON.stringify(
        {
          decision: "fail",
          justification: "Evaluator still rejected the paused history path.",
          evidence: ["bun test src/loop/engine.test.ts"],
          recommended_next_action: "Inspect the evaluator findings and narrow the next sub-task before resuming."
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    try {
      const runs = await listRuns(makeTestConfig(homeDir));

      expect(runs).toHaveLength(1);
      expect(runs[0]?.summary).toContain("## Auto Rework Attempts");
      expect(runs[0]?.summary).toContain("Attempt 1/2:");
      expect(runs[0]?.summary).toContain("Attempt 2/2:");
      expect(runs[0]?.summary).toContain("## Round Outcome");
      expect(runs[0]?.summary).toContain(
        "Paused for operator review after 2 auto rework attempts still ended in evaluator failure."
      );
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
      hot_file_governance: null,
      log: "OPENAI_API_KEY=[REDACTED]\n",
      state_change: "+ SESSION_SECRET=[REDACTED]\n",
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
      hot_file_governance: null,
      log: "round log\n",
      state_change: "state diff\n",
      artifacts: {
        kind: "full_bundle",
        label: "Full evidence bundle",
        present: ["log", "summary", "metrics", "state_change", "evaluation"],
        missing: []
      },
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
        hot_file_governance: null,
        log: "sessionSecret=[REDACTED]\n",
        state_change: "+ apiToken=[REDACTED]\n",
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
        }
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("returns a partial bundle with missing-artifact metadata when evaluation is absent", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-missing-test-"));
    const paths = buildLoopPaths(homeDir);
    const runsDir = path.join(homeDir, "runs");
    const timestamp = "2026-03-01T02-00-00-000Z";

    await writeRunArtifacts(runsDir, timestamp, {
      summary: "summary\n",
      metrics: { round: 2, status: "success" },
      log: "log\n",
      stateChange: "diff\n"
    });

    expect(await getRunArtifacts(makeTestConfig(homeDir), timestamp)).toEqual({
      timestamp,
      summary: "summary\n",
      metrics: {
        round: 2,
        status: "success"
      },
      evaluation: null,
      hot_file_governance: null,
      log: "log\n",
      state_change: "diff\n",
      artifacts: {
        kind: "partial_bundle",
        label: "Partial bundle",
        present: ["log", "summary", "metrics", "state_change"],
        missing: ["evaluation"]
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
      }
    });
    expect(await getRunArtifacts(makeTestConfig(homeDir), "../outside")).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("returns log-only bundles with explicit missing-artifact metadata", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-log-only-test-"));
    const paths = buildLoopPaths(homeDir);
    const timestamp = "2026-03-01T02-30-00-000Z";

    await writeRunArtifacts(paths.runsDir, timestamp, {
      log: "log only\n"
    });

    expect(await getRunArtifacts(makeTestConfig(homeDir), timestamp)).toEqual({
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
      }
    });
    expect(await getRunArtifacts(makeTestConfig(homeDir), "../outside")).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("hot-file governance contract", () => {
  test("keeps one persisted payload aligned across status, run history, and artifact views", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-hot-file-contract-test-"));
    const paths = buildLoopPaths(homeDir);
    const timestamp = "2026-03-10T12-00-00-000Z";
    await fs.mkdir(homeDir, { recursive: true });

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
        evidence: ["bun test src/loop/control.test.ts"],
        hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
      },
      log: "governed log\n",
      stateChange: "governed diff\n"
    });
    await saveEvaluation(paths, 4, {
      decision: "fail",
      justification: "Hot-file governance blocked further growth.",
      evidence: ["bun test src/loop/control.test.ts"],
      hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
    });

    const [status, runs, artifacts] = await Promise.all([
      getLoopStatus(makeTestConfig(homeDir)),
      listRuns(makeTestConfig(homeDir)),
      getRunArtifacts(makeTestConfig(homeDir), timestamp)
    ]);

    expect(status.hot_file_governance).toEqual(HOT_FILE_GOVERNANCE_PAYLOAD);
    expect(runs).toEqual([
      expect.objectContaining({
        timestamp,
        hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
        evaluation: expect.objectContaining({
          hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
        })
      })
    ]);
    expect(artifacts).toEqual(
      expect.objectContaining({
        timestamp,
        hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD,
        evaluation: expect.objectContaining({
          hot_file_governance: HOT_FILE_GOVERNANCE_PAYLOAD
        })
      })
    );

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

  test("clears stale pause metadata when a paused loop resumes on a live pid", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-resume-clear-pause-metadata-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await setFlag(paths.pauseFlagPath);
    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "paused",
      pid: process.pid,
      pause_reason: "Budget breach",
      last_error: "BudgetBreach: action budget exceeded",
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 1,
          actions: 5
        },
        usage: {
          usdUsed: 0.8,
          actionsUsed: 6,
          elapsedMs: 20_000
        }
      }
    });

    await resumeLoop(config);

    const state = await readLoopState(paths);
    expect(state).toMatchObject({
      state: "running",
      pid: process.pid,
      pause_reason: null,
      last_error: null,
      current_budget: null
    });

    const status = await getCliStatus(config);
    expect(status.state.pause_reason).toBeNull();
    expect(status.state.operator_reason).toBeNull();
    expect(status.state.last_error).toBeNull();
    expect(status.state.current_budget).toBeNull();

    const output = renderCliStatus(status);
    expect(output).not.toContain("Pause / risk reason:");
    expect(output).not.toContain("Last error:");

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

      const runningState = await waitForRunningState(homeDir, 5_000);
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

  test("fails clearly without mutating state or flags when the loop is not paused", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-resume-invalid-state-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await setFlag(paths.pauseFlagPath);
    await writeLoopState(paths, {
      ...defaultLoopState(process.pid),
      state: "running",
      pid: process.pid
    });

    const beforeState = await readLoopState(paths);

    await expect(resumeLoop(config)).rejects.toThrow("Invalid control transition: resume is only allowed from paused.");

    expect(await hasFlag(paths.pauseFlagPath)).toBe(true);
    expect(await readLoopState(paths)).toEqual(beforeState);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("stopLoop", () => {
  test("clears stale pause metadata when stopping a paused loop without a live pid", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-stop-clear-pause-metadata-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await setFlag(paths.pauseFlagPath);
    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      pid: null,
      pause_reason: "Manual pause",
      last_error: "Waiting for review",
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 1,
          actions: 5
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 2,
          elapsedMs: 10_000
        }
      }
    });

    await stopLoop(config);

    const state = await readLoopState(paths);
    expect(state).toMatchObject({
      state: "idle",
      pid: null,
      pause_reason: null,
      last_error: null,
      current_budget: null
    });

    const status = await getCliStatus(config);
    expect(status.state.pause_reason).toBeNull();
    expect(status.state.operator_reason).toBeNull();
    expect(status.state.last_error).toBeNull();
    expect(status.state.current_budget).toBeNull();

    const output = renderCliStatus(status);
    expect(output).not.toContain("Pause / risk reason:");
    expect(output).not.toContain("Last error:");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("fails clearly without mutating state or flags when the loop is idle", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-stop-invalid-idle-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    const beforeState = await readLoopState(paths);

    await expect(stopLoop(config)).rejects.toThrow(
      "Invalid control transition: stop is only allowed from starting, running, cooldown, or paused."
    );

    expect(await hasFlag(paths.stopFlagPath)).toBe(false);
    expect(await readLoopState(paths)).toEqual(beforeState);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("getLoopStatus", () => {
  test("includes the current queued operator instruction count in the status payload", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-instruction-count-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "running",
      round: 6
    });
    await appendInstruction(paths, "Re-check the failing console status test.");
    await appendInstruction(paths, "Keep the next change minimal.");

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status.pending_instruction_count).toBe(2);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("returns the persisted active pause reason in the status payload", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-pause-reason-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 7,
      pause_reason: "Budget breach",
      last_error: "BudgetBreach: action budget exceeded"
    });

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status.pause_reason).toBe("Budget breach");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("derives log-only completeness from the latest persisted round artifacts", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-artifact-log-only-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "running",
      round: 9
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-15T01-49-21-350Z", {
      summary: "older summary",
      metrics: { round: 8 },
      log: "older log",
      stateChange: "older diff",
      evaluation: { decision: "pass", justification: "older evaluation", evidence: [] }
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-15T02-16-09-241Z", {
      log: "latest in-flight log"
    });

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status.artifact_completeness).toEqual({
      kind: "log_only",
      label: "Log only",
      latest_round_timestamp: "2026-03-15T02-16-09-241Z",
      latest_artifact_at: expect.any(String),
      present: ["log"],
      missing: ["summary", "metrics", "state_change", "evaluation"]
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("derives partial bundle completeness from the latest persisted round artifacts", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-artifact-partial-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 10
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-15T03-00-00-000Z", {
      summary: "partial summary",
      metrics: { round: 10 },
      log: "partial log"
    });

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status.artifact_completeness).toEqual({
      kind: "partial_bundle",
      label: "Partial bundle",
      latest_round_timestamp: "2026-03-15T03-00-00-000Z",
      latest_artifact_at: expect.any(String),
      present: ["log", "summary", "metrics"],
      missing: ["state_change", "evaluation"]
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

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
      operator_reason: {
        kind: "manual_pause",
        title: "Manual pause",
        summary: "Run is paused and waiting for operator review.",
        next_action: "Inspect the run state and resume explicitly when safe.",
        severity: "warning"
      },
      artifact_completeness: {
        kind: "none",
        label: "No artifacts yet",
        latest_round_timestamp: null,
        latest_artifact_at: null,
        present: [],
        missing: ["log", "summary", "metrics", "state_change", "evaluation"]
      },
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

  test("derives a structured budget breach reason from paused runtime state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-budget-reason-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 8,
      last_error: "BudgetBreach: action budget exceeded",
      current_budget: {
        limits: {
          usdPerRound: 1,
          timeMinutes: 2,
          actions: 5
        },
        usage: {
          usdUsed: 0.9,
          actionsUsed: 7,
          elapsedMs: 30_000
        }
      }
    });

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status.operator_reason).toEqual({
      kind: "budget_breach",
      title: "Budget breach",
      summary: "Paused because the action budget was exceeded (7 / 5).",
      next_action: "Review the last budget snapshot and reduce scope or raise budgets before resuming.",
      severity: "critical"
    });
    expect(status.budget_health).toEqual({
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
          used: 7,
          limit: 5,
          ratio: 1.4
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
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("surfaces strategic evaluator governance distinctly from generic evaluator failure limits", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-hot-file-governance-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    const hotFileGovernance = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
      result_class: "hot_file_growth_failure" as const,
      reason: "continued growth in pressured file without bounded justification",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    await writeLoopState(paths, {
      ...defaultLoopState(),
      state: "paused",
      round: 9,
      last_error: "EvaluatorStrategicBlock: Further retries require immediate hot-file governance review.",
      previous_hot_file_governance: hotFileGovernance
    });

    const status = await getLoopStatus(makeTestConfig(homeDir));

    expect(status.hot_file_governance).toEqual(hotFileGovernance);
    expect(status.operator_reason).toEqual({
      kind: "hot_file_governance",
      title: "Hot-file governance block",
      summary:
        "Paused because the evaluator requested immediate hot-file governance review for src/loop/engine.ts. Class: hot_file_growth_failure. Reason: continued growth in pressured file without bounded justification. Labels: recent-touch hot-file pressure, line-count pressure.",
      next_action: "pause and split the next change into a bounded structural-maintenance pass",
      severity: "critical"
    });

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
    expect(status.last_error).toContain("Crash recovery");
    expect(status.last_error).toContain("status check");
    expect(status.operator_reason).toEqual({
      kind: "crash_recovery",
      title: "Crash recovery",
      summary: "Initialization was interrupted before normal round execution began.",
      next_action: "Inspect the run state and resume explicitly when safe.",
      severity: "critical"
    });
    expect(status.crash_recovery).toEqual({
      interruption_type: "startup_interrupted",
      interrupted_state: "starting",
      recovered_by: "status_check",
      status_check_finalized: true,
      normal_round_execution_started: false,
      incomplete_work: false,
      reason: "process 999999 was not alive",
      summary: "Initialization was interrupted before normal round execution began.",
      next_action: "Inspect the run state and resume explicitly when safe."
    });

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
    expect(status.last_error).toContain("Crash recovery");
    expect(status.last_error).toContain("status check");
    expect(status.operator_reason).toEqual({
      kind: "crash_recovery",
      title: "Crash recovery",
      summary: "Round execution was interrupted during cooldown; work may be incomplete.",
      next_action: "Inspect the run state and resume explicitly when safe.",
      severity: "critical"
    });
    expect(status.crash_recovery).toEqual({
      interruption_type: "round_interrupted",
      interrupted_state: "cooldown",
      recovered_by: "status_check",
      status_check_finalized: true,
      normal_round_execution_started: true,
      incomplete_work: true,
      reason: "process 999999 was not alive",
      summary: "Round execution was interrupted during cooldown; work may be incomplete.",
      next_action: "Inspect the run state and resume explicitly when safe."
    });

    const persisted = await readLoopState(paths);
    expect(persisted.state).toBe("paused");
    expect(persisted.round).toBe(3);
    expect(persisted.pid).toBeNull();
    expect(persisted.current_budget).toEqual(staleState.current_budget);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("surfaces a critical risk when a live running process loses its lifecycle markers and stops updating state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-stalled-live-process-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      round: 17,
      state: "running",
      pid: process.pid
    });

    const db = new Database(paths.dbPath, { create: true });
    db.run(
      `
        UPDATE system_state
        SET updated_at = ?
        WHERE id = 1
      `,
      [new Date(Date.now() - 20 * 60_000).toISOString()]
    );
    db.close();

    const status = await getLoopStatus(makeTestConfig(homeDir));
    expect(status.state).toBe("running");
    expect(status.pid_alive).toBe(true);
    expect(status.operator_reason).toEqual({
      kind: "engine_error",
      title: "Engine error",
      summary: expect.stringContaining("lifecycle markers"),
      next_action: "Inspect the live PID, stop the loop if it remains idle, then resume explicitly when safe.",
      severity: "critical"
    });
    expect(status.operator_reason?.summary).toContain("state heartbeat");
    expect(status.operator_reason?.summary).toContain("lock file");
    expect(status.operator_reason?.summary).toContain("pid file");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("does not surface a lifecycle marker risk while the current round log is still advancing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-status-live-log-activity-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      round: 17,
      state: "running",
      pid: process.pid
    });
    await writeRunArtifacts(paths.runsDir, "2026-03-16T14-55-28-494Z", {
      log: "still making progress\n"
    });

    const db = new Database(paths.dbPath, { create: true });
    db.run(
      `
        UPDATE system_state
        SET updated_at = ?
        WHERE id = 1
      `,
      [new Date(Date.now() - 20 * 60_000).toISOString()]
    );
    db.close();

    const status = await getLoopStatus(makeTestConfig(homeDir));
    expect(status.state).toBe("running");
    expect(status.pid_alive).toBe(true);
    expect(status.artifact_completeness.kind).toBe("log_only");
    expect(status.operator_reason).toBeNull();

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

  test("renders compact startup-interrupted crash recovery status without marking work incomplete", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-cli-status-startup-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      round: 4,
      state: "starting",
      pid: 999999
    });

    const output = renderCliStatus(await getCliStatus(config));

    expect(output).toContain("State: paused");
    expect(output).toContain("Pause / risk reason: Crash recovery");
    expect(output).toContain("Reason summary: Initialization was interrupted before normal round execution began.");
    expect(output).toContain("Interruption: startup interrupted");
    expect(output).toContain("Round context: run round 4");
    expect(output).toContain("Round incomplete: no");
    expect(output).toContain("Initialization was interrupted before normal round execution began.");
    expect(output).toContain("Recovery was finalized during this status check.");
    expect(output).toContain("Next safe action: Inspect the run state and resume explicitly when safe.");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("renders compact round-interrupted crash recovery status with incomplete work", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-cli-status-round-test-"));
    const paths = buildLoopPaths(homeDir);
    const config = makeTestConfig(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    await writeLoopState(paths, {
      ...defaultLoopState(),
      round: 3,
      state: "cooldown",
      pid: 999999
    });

    const output = renderCliStatus(await getCliStatus(config));

    expect(output).toContain("State: paused");
    expect(output).toContain("Pause / risk reason: Crash recovery");
    expect(output).toContain("Reason summary: Round execution was interrupted during cooldown; work may be incomplete.");
    expect(output).toContain("Interruption: round interrupted");
    expect(output).toContain("Interrupted during: cooldown");
    expect(output).toContain("Round context: run round 3");
    expect(output).toContain("Round incomplete: yes");
    expect(output).toContain("Round execution was interrupted during cooldown; work may be incomplete.");
    expect(output).toContain("Recovery was finalized during this status check.");
    expect(output).toContain("Next safe action: Inspect the run state and resume explicitly when safe.");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("renders already-paused crash recovery without implying a new status mutation", async () => {
    const output = renderCliStatus({
      budget: {
        usdPerRound: 1,
        timeMinutes: 1,
        actions: 10
      },
      state: {
        ...defaultLoopState(),
        state: "paused",
        round: 2,
        pid_alive: false,
        pending_instruction_count: 0,
        operator_reason: {
          kind: "crash_recovery",
          title: "Crash recovery",
          summary: "Initialization was interrupted before normal round execution began.",
          next_action: "Inspect the run state and resume explicitly when safe.",
          severity: "critical"
        },
        budget_health: null,
        artifact_completeness: {
          kind: "none",
          label: "No artifacts yet",
          latest_round_timestamp: null,
          latest_artifact_at: null,
          present: [],
          missing: ["log", "summary", "metrics", "state_change", "evaluation"]
        },
        last_error:
          "Crash recovery: Interrupted state recovered during startup. Startup interrupted during initialization because process 123 was not alive. Normal round execution did not begin. Run paused for review. Next action: Inspect the run state and resume explicitly when safe.",
        crash_recovery: {
          interruption_type: "startup_interrupted",
          interrupted_state: "starting",
          recovered_by: "startup",
          status_check_finalized: false,
          normal_round_execution_started: false,
          incomplete_work: false,
          reason: "process 123 was not alive",
          summary: "Initialization was interrupted before normal round execution began.",
          next_action: "Inspect the run state and resume explicitly when safe."
        },
        active_requirement: {
          path: "",
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
      }
    });

    expect(output).toContain("Run is already paused for crash review.");
    expect(output).not.toContain("Recovery was finalized during this status check.");
  });

  test("renders a structured budget breach reason before lower-level status details", () => {
    const output = renderCliStatus({
      budget: {
        usdPerRound: 1,
        timeMinutes: 1,
        actions: 10
      },
      state: {
        ...defaultLoopState(),
        state: "paused",
        round: 2,
        pid_alive: false,
        pending_instruction_count: 3,
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
              health: "healthy",
              used: 0.3,
              limit: 1,
              ratio: 0.3
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
              used: 12_000,
              limit: 60_000,
              ratio: 0.2
            }
          ]
        },
        last_error: "BudgetBreach: action budget exceeded",
        crash_recovery: null,
        artifact_completeness: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          latest_round_timestamp: "2026-03-15T02-16-09-241Z",
          latest_artifact_at: "2026-03-15T02:16:11.000Z",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
        },
        current_budget: {
          limits: {
            usdPerRound: 1,
            timeMinutes: 1,
            actions: 10
          },
          usage: {
            usdUsed: 0.3,
            actionsUsed: 11,
            elapsedMs: 12_000
          }
        },
        active_requirement: {
          path: "",
          exists: false,
          artifact_status: "missing",
          lifecycle_status: "active",
          title: null,
          summary: "Keep the operator-visible reason in sync with persisted state.",
          acceptance_criteria_total: 0,
          acceptance_criteria_completed: 0,
          markdown: null,
          updated_at: null
        }
      }
    });

    expect(output).toContain("Pause / risk reason: Budget breach");
    expect(output).toContain("Reason summary: Paused because the action budget was exceeded (11 / 10).");
    expect(output).toContain(
      "Next safe action: Review the last budget snapshot and reduce scope or raise budgets before resuming."
    );
    expect(output).toContain("Pending instructions: 3");
    expect(output).toContain("Budget health: breached");
    expect(output).toContain("Budget dimension health: USD=healthy, Actions=breached, Time=healthy");
    expect(output).toContain("Breached dimension: Actions");
    expect(output).toContain("Artifact completeness: Full evidence bundle");
    expect(output).toContain("Latest artifact timestamp: 2026-03-15T02:16:11.000Z");
    expect(output).toContain("Last error: BudgetBreach: action budget exceeded");
    expect(output).toContain("Current budget usage: $0.3, 12000ms, 11 actions");
  });

  test("renders hot-file governance details before lower-level pause context", () => {
    const hotFileGovernance = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
      result_class: "hot_file_growth_failure" as const,
      reason: "continued growth in pressured file without bounded justification",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    const output = renderCliStatus({
      budget: {
        usdPerRound: 1,
        timeMinutes: 1,
        actions: 10
      },
      state: {
        ...defaultLoopState(),
        state: "paused",
        round: 6,
        pid_alive: false,
        pending_instruction_count: 1,
        operator_reason: {
          kind: "hot_file_governance",
          title: "Hot-file governance block",
          summary:
            "Paused after repeated hot-file governance failures in src/loop/engine.ts. Class: hot_file_growth_failure. Reason: continued growth in pressured file without bounded justification. Labels: recent-touch hot-file pressure, line-count pressure.",
          next_action: "pause and split the next change into a bounded structural-maintenance pass",
          severity: "critical"
        },
        hot_file_governance: hotFileGovernance,
        budget_health: null,
        last_error: "EvaluatorFailureLimit: repeated evaluator failures require operator review.",
        crash_recovery: null,
        artifact_completeness: {
          kind: "full_bundle",
          label: "Full evidence bundle",
          latest_round_timestamp: "2026-03-16T14-55-28-494Z",
          latest_artifact_at: "2026-03-16T14:55:29.000Z",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
        },
        current_budget: null,
        active_requirement: {
          path: "",
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
      }
    });

    expect(output).toContain("Pause / risk reason: Hot-file governance block");
    expect(output).toContain("Hot-file governance: hot_file_growth_failure @ src/loop/engine.ts");
    expect(output).toContain("Hot-file labels: recent-touch hot-file pressure, line-count pressure");
    expect(output).toContain(
      "Hot-file next action: pause and split the next change into a bounded structural-maintenance pass"
    );
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

describe("external-validation report CLI", () => {
  test("groups persisted metrics by sub_task_identity stable_id instead of summary markdown", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-report-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs");
    const parserBugTask = buildRoundSubTaskIdentity({
      rationale: "Fix a parser bug exposed in pilot validation.",
      assignee: "executor",
      objective: "Fix parser bug",
      expected_outcome: "Parser accepts escaped commas reliably.",
      impacted_files: ["/tmp/parser.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });
    const addFlagTask = buildRoundSubTaskIdentity({
      rationale: "Add a bounded feature to the pilot repository.",
      assignee: "executor",
      objective: "Add feature flag",
      expected_outcome: "Feature flag toggles the new behavior.",
      impacted_files: ["/tmp/feature.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });

    try {
      await fs.mkdir(runsDir, { recursive: true });

      await writeRunArtifacts(runsDir, "2026-03-18T09-00-00-000Z", {
        summary: "# Round Summary\n\nTask: shared summary label\n",
        metrics: makePersistedRoundMetrics({
          round: 1,
          run_timestamp: "2026-03-18T09:00:00.000Z",
          evaluator_decision: "fail",
          human_interventions: 1,
          hot_file_growth_lines: 3,
          sub_task_identity: parserBugTask
        }),
        evaluation: {
          decision: "fail",
          justification: "Need one more bounded retry.",
          evidence: []
        }
      });

      await writeRunArtifacts(runsDir, "2026-03-18T09-05-00-000Z", {
        summary: "# Round Summary\n\nTask: different summary label\n",
        metrics: makePersistedRoundMetrics({
          round: 2,
          run_timestamp: "2026-03-18T09:05:00.000Z",
          evaluator_decision: "pass",
          human_interventions: 0,
          hot_file_growth_lines: 2,
          sub_task_identity: parserBugTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Task completed successfully.",
          evidence: []
        }
      });

      await writeRunArtifacts(runsDir, "2026-03-18T09-10-00-000Z", {
        summary: "# Round Summary\n\nTask: shared summary label\n",
        metrics: makePersistedRoundMetrics({
          round: 3,
          run_timestamp: "2026-03-18T09:10:00.000Z",
          evaluator_decision: "fail",
          human_interventions: 2,
          hot_file_growth_lines: 4,
          sub_task_identity: addFlagTask
        }),
        evaluation: {
          decision: "fail",
          justification: "Evaluator infrastructure failure: provider rate limiting blocked evaluation.",
          root_cause: "evaluator_infrastructure:provider_rate_limit",
          evidence: []
        }
      });

      const result = runAiloopCli(["external-validation", "report"], workspaceRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("External validation metrics report");
      expect(result.stdout).toContain("Tasks analyzed: 2");
      expect(result.stdout).toContain("Successful tasks: 1");
      expect(result.stdout).not.toContain("Baseline checklist comparison:");
      expect(result.stdout).toContain(
        `- Fix parser bug | stable_id=${parserBugTask.stable_id} | rounds=2`
      );
      expect(result.stdout).toContain(
        `- Fix parser bug | stable_id=${parserBugTask.stable_id} | count=1`
      );
      expect(result.stdout).toContain(
        `- Add feature flag | stable_id=${addFlagTask.stable_id} | count=2`
      );
      expect(result.stdout).toContain(
        `- Add feature flag | stable_id=${addFlagTask.stable_id} | count=1`
      );
      expect(result.stdout).toContain(
        `- Fix parser bug | stable_id=${parserBugTask.stable_id} | lines=5`
      );
      expect(result.stdout).toContain(
        `- Add feature flag | stable_id=${addFlagTask.stable_id} | lines=4`
      );
      expect(result.stdout).not.toContain("shared summary label");
      expect(result.stdout).not.toContain("different summary label");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports stable-id scoped no-op claim mismatches without attributing them to unaffected tasks", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-no-op-report-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs");
    const mismatchTask = buildRoundSubTaskIdentity({
      rationale: "Pilot operators need a concrete mismatch count for false no-op claims.",
      assignee: "executor",
      objective: "Reconcile no-op summary claims",
      expected_outcome: "The report counts rounds where summary claims no code changes despite recorded edits.",
      impacted_files: ["/tmp/reporting.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });
    const unaffectedTask = buildRoundSubTaskIdentity({
      rationale: "This task makes an intentional workspace edit and should not count as a no-op mismatch.",
      assignee: "executor",
      objective: "Ship the intentional report update",
      expected_outcome: "The report shows zero mismatches for rounds that accurately summarize edits.",
      impacted_files: ["/tmp/control.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });

    try {
      await fs.mkdir(runsDir, { recursive: true });

      await writeRunArtifacts(runsDir, "2026-03-18T10-00-00-000Z", {
        summary: [
          "# AILoop Round Summary",
          "",
          "## Execution Result",
          "- Work Summary: No code change was required; verified the reporting path without workspace edits."
        ].join("\n"),
        metrics: makePersistedRoundMetrics({
          round: 1,
          run_timestamp: "2026-03-18T10:00:00.000Z",
          evaluator_decision: "fail",
          human_interventions: 0,
          hot_file_growth_lines: 2,
          sub_task_identity: mismatchTask
        }),
        evaluation: {
          decision: "fail",
          justification: "Summary claim conflicts with recorded state change.",
          evidence: []
        },
        stateChange: [
          "### Snapshot File Diffs",
          "```diff",
          "--- a/src/reporting/metrics.ts",
          "+++ b/src/reporting/metrics.ts",
          "@@ -150,0 +151,4 @@",
          "+export const mismatchCount = 1;",
          "```"
        ].join("\n")
      });

      await writeRunArtifacts(runsDir, "2026-03-18T10-05-00-000Z", {
        summary: [
          "# AILoop Round Summary",
          "",
          "## Execution Result",
          "- Work Summary: Updated the report renderer and added the mismatch count output."
        ].join("\n"),
        metrics: makePersistedRoundMetrics({
          round: 2,
          run_timestamp: "2026-03-18T10:05:00.000Z",
          evaluator_decision: "pass",
          human_interventions: 1,
          hot_file_growth_lines: 3,
          sub_task_identity: unaffectedTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Intentional edit completed.",
          evidence: []
        },
        stateChange: [
          "### Snapshot File Diffs",
          "```diff",
          "--- a/src/loop/control.ts",
          "+++ b/src/loop/control.ts",
          "@@ -280,0 +281,4 @@",
          '+  lines.push("No-op claim mismatches per task:");',
          "```"
        ].join("\n")
      });

      const result = runAiloopCli(["external-validation", "report"], workspaceRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("No-op claim mismatches per task:");
      expect(result.stdout).toContain(
        `- Reconcile no-op summary claims | stable_id=${mismatchTask.stable_id} | count=1`
      );
      expect(result.stdout).toContain(
        `- Ship the intentional report update | stable_id=${unaffectedTask.stable_id} | count=0`
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("renders per-task total and average USD cost in the external-validation report", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-cost-report-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs");
    const costTrackedTask = buildRoundSubTaskIdentity({
      rationale: "Operators need round-level cost visibility for the same external-validation task.",
      assignee: "executor",
      objective: "Track pilot cost by task identity",
      expected_outcome: "The report shows total USD and average USD per round for the matching stable id.",
      impacted_files: ["/tmp/reporting.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });
    const separateTask = buildRoundSubTaskIdentity({
      rationale: "A different stable id should keep its own cost totals.",
      assignee: "executor",
      objective: "Track pilot cost by task identity",
      expected_outcome: "A separate stable id reports its own per-task cost section entry.",
      impacted_files: ["/tmp/control.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });

    try {
      await fs.mkdir(runsDir, { recursive: true });

      await writeRunArtifacts(runsDir, "2026-03-18T11-00-00-000Z", {
        summary: "# Round Summary\n\nRecorded initial task cost.\n",
        metrics: makePersistedRoundMetrics({
          round: 1,
          run_timestamp: "2026-03-18T11:00:00.000Z",
          evaluator_decision: "fail",
          human_interventions: 0,
          hot_file_growth_lines: 1,
          usdUsed: 0.12,
          sub_task_identity: costTrackedTask
        }),
        evaluation: {
          decision: "fail",
          justification: "One more bounded round required.",
          evidence: []
        }
      });

      await writeRunArtifacts(runsDir, "2026-03-18T11-05-00-000Z", {
        summary: "# Round Summary\n\nRecorded follow-up task cost.\n",
        metrics: makePersistedRoundMetrics({
          round: 2,
          run_timestamp: "2026-03-18T11:05:00.000Z",
          evaluator_decision: "pass",
          human_interventions: 0,
          hot_file_growth_lines: 1,
          usdUsed: 0.18,
          sub_task_identity: costTrackedTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Task completed within budget.",
          evidence: []
        }
      });

      await writeRunArtifacts(runsDir, "2026-03-18T11-10-00-000Z", {
        summary: "# Round Summary\n\nRecorded cost for a separate stable id.\n",
        metrics: makePersistedRoundMetrics({
          round: 3,
          run_timestamp: "2026-03-18T11:10:00.000Z",
          evaluator_decision: "pass",
          human_interventions: 0,
          hot_file_growth_lines: 0,
          usdUsed: 0.8,
          sub_task_identity: separateTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Independent task completed.",
          evidence: []
        }
      });

      const result = runAiloopCli(["external-validation", "report"], workspaceRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Verification checklist summary:");
      expect(result.stdout).toContain("- Rounds per successful task: 1.50 (target < 5)");
      expect(result.stdout).toContain("- Human interventions per task: 0.00 (target < 2)");
      expect(result.stdout).toContain("- Average cost per round (USD): 0.3667");
      expect(result.stdout).toContain("- Evaluator infrastructure failures: 0 (target 0)");
      expect(result.stdout).toContain("- Hot-file growth lines: 2 (target 0)");
      expect(result.stdout).toContain("Cost per task (USD):");
      expect(result.stdout).toContain(
        `- Track pilot cost by task identity | stable_id=${costTrackedTask.stable_id} | total_usd=0.3000 | avg_usd_per_round=0.1500`
      );
      expect(result.stdout).toContain(
        `- Track pilot cost by task identity | stable_id=${separateTask.stable_id} | total_usd=0.8000 | avg_usd_per_round=0.8000`
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("renders below-threshold action-budget evidence descriptively without governance escalation wording", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-action-budget-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs");
    const actionHeavyTask = buildRoundSubTaskIdentity({
      rationale: "Operators need the most action-heavy persisted round called out directly in the report.",
      assignee: "executor",
      objective: "Inspect action-heavy pilot evidence",
      expected_outcome: "The report links the same-round evidence bundle for the highest actionsUsed/actions round.",
      impacted_files: ["/tmp/external-validation.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });
    const lowerActionTask = buildRoundSubTaskIdentity({
      rationale: "A lower-action round should not replace the most action-heavy evidence bundle.",
      assignee: "executor",
      objective: "Inspect action-heavy pilot evidence",
      expected_outcome: "A lower action count stays out of the report evidence section.",
      impacted_files: ["/tmp/metrics.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });
    const expectedTimestamp = "2026-03-18T11-15-00-000Z";

    try {
      await fs.mkdir(runsDir, { recursive: true });

      await writeRunArtifacts(runsDir, "2026-03-18T11-10-00-000Z", {
        summary: "# Round Summary\n\nRecorded a lower-action comparison round.\n",
        metrics: makePersistedRoundMetrics({
          round: 1,
          run_timestamp: "2026-03-18T11-10-00-000Z",
          evaluator_decision: "pass",
          human_interventions: 0,
          hot_file_growth_lines: 0,
          actionsUsed: 4,
          actionLimit: 10,
          sub_task_identity: lowerActionTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Comparison round completed successfully.",
          evidence: []
        },
        stateChange: "No state changes detected."
      });

      await writeRunArtifacts(runsDir, expectedTimestamp, {
        summary: "# Round Summary\n\nRecorded the most action-heavy round within the documented budget.\n",
        metrics: makePersistedRoundMetrics({
          round: 2,
          run_timestamp: expectedTimestamp,
          evaluator_decision: "fail",
          human_interventions: 1,
          hot_file_growth_lines: 1,
          actionsUsed: 7,
          actionLimit: 10,
          sub_task_identity: actionHeavyTask
        }),
        evaluation: {
          decision: "fail",
          justification: "One more bounded retry is available.",
          evidence: []
        },
        stateChange: "No state changes detected."
      });

      const resolvedRunsDir = await fs.realpath(runsDir);
      const result = runAiloopCli(["external-validation", "report"], workspaceRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Action-budget evidence (most action-heavy round):");
      expect(result.stdout).toContain(
        `- Inspect action-heavy pilot evidence | stable_id=${actionHeavyTask.stable_id} | round=2 | actions=7 / 10`
      );
      expect(result.stdout).toContain(`- Timestamp: ${expectedTimestamp}`);
      expect(result.stdout).toContain("- Interpretation: Within the persisted action budget; descriptive evidence only.");
      expect(result.stdout).toContain(
        `- Summary artifact: ${path.join(resolvedRunsDir, `${expectedTimestamp}.round.summary.md`)}`
      );
      expect(result.stdout).toContain(
        `- Evaluation artifact: ${path.join(resolvedRunsDir, `${expectedTimestamp}.round.evaluation.json`)}`
      );
      expect(result.stdout).toContain(
        `- State-change artifact: ${path.join(resolvedRunsDir, `${expectedTimestamp}.round.state_change.txt`)}`
      );
      expect(result.stdout).not.toContain("CCB");
      expect(result.stdout).not.toContain("escalat");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("prints baseline, pilot, and delta checklist values when an explicit baseline runs directory is supplied", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-baseline-report-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const pilotRunsDir = path.join(homeDir, "runs");
    const baselineRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-self-iteration-runs-"));
    const comparedTask = buildRoundSubTaskIdentity({
      rationale: "Operators need a narrow self-iteration baseline comparison.",
      assignee: "executor",
      objective: "Compare pilot checklist metrics against a self-iteration baseline",
      expected_outcome: "The report shows baseline, pilot, and delta checklist values.",
      impacted_files: ["/tmp/metrics.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    });

    try {
      await writeRunArtifacts(baselineRunsDir, "2026-03-18T12-00-00-000Z", {
        summary: "# Round Summary\n\nRecorded self-iteration baseline.\n",
        metrics: makePersistedRoundMetrics({
          round: 1,
          run_timestamp: "2026-03-18T12:00:00.000Z",
          evaluator_decision: "pass",
          human_interventions: 1,
          hot_file_growth_lines: 2,
          usdUsed: 0.05,
          sub_task_identity: comparedTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Baseline task completed successfully.",
          evidence: []
        }
      });

      await writeRunArtifacts(pilotRunsDir, "2026-03-19T12-00-00-000Z", {
        summary: "# Round Summary\n\nRecorded pilot retry.\n",
        metrics: makePersistedRoundMetrics({
          round: 1,
          run_timestamp: "2026-03-19T12:00:00.000Z",
          evaluator_decision: "fail",
          human_interventions: 1,
          hot_file_growth_lines: 3,
          usdUsed: 0.1,
          sub_task_identity: comparedTask
        }),
        evaluation: {
          decision: "fail",
          justification: "Evaluator infrastructure failure: upstream timeout during pilot validation.",
          root_cause: "evaluator_infrastructure:upstream_timeout",
          evidence: []
        }
      });

      await writeRunArtifacts(pilotRunsDir, "2026-03-19T12-05-00-000Z", {
        summary: "# Round Summary\n\nRecorded pilot success.\n",
        metrics: makePersistedRoundMetrics({
          round: 2,
          run_timestamp: "2026-03-19T12:05:00.000Z",
          evaluator_decision: "pass",
          human_interventions: 1,
          hot_file_growth_lines: 3,
          usdUsed: 0.3,
          sub_task_identity: comparedTask
        }),
        evaluation: {
          decision: "pass",
          justification: "Pilot task completed successfully.",
          evidence: []
        }
      });

      const result = runAiloopCli(["external-validation", "report", baselineRunsDir], workspaceRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Baseline comparison runs dir: ${baselineRunsDir}`);
      expect(result.stdout).toContain("Baseline checklist comparison:");
      expect(result.stdout).toContain(
        "- Rounds per successful task: baseline=1.00 | pilot=2.00 | delta=+1.00"
      );
      expect(result.stdout).toContain(
        "- Human interventions per task: baseline=1.00 | pilot=2.00 | delta=+1.00"
      );
      expect(result.stdout).toContain(
        "- Average cost per round (USD): baseline=0.0500 | pilot=0.2000 | delta=+0.1500"
      );
      expect(result.stdout).toContain(
        "- Evaluator infrastructure failures: baseline=0 | pilot=1 | delta=+1"
      );
      expect(result.stdout).toContain("- Hot-file growth lines: baseline=2 | pilot=6 | delta=+4");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(baselineRunsDir, { recursive: true, force: true });
    }
  });

  test("fails clearly when the requested baseline runs directory does not exist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-control-external-validation-invalid-baseline-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const config = makeTestConfig(homeDir);

    try {
      await expect(
        runExternalValidationMetricsReport(config, "missing-baseline-runs", workspaceRoot)
      ).rejects.toBeInstanceOf(InvalidExternalValidationBaselineRunsDirError);
      await expect(
        runExternalValidationMetricsReport(config, "missing-baseline-runs", workspaceRoot)
      ).rejects.toThrow(
        `Baseline runs directory does not exist: ${path.join(workspaceRoot, "missing-baseline-runs")}`
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("external-validation preflight CLI", () => {
  test("prints a passing eligibility summary for a valid candidate repository", async () => {
    const repoDir = await createExternalValidationCandidate();

    try {
      const expectedRepoPath = path.join(await fs.realpath(path.dirname(repoDir)), path.basename(repoDir));
      const result = runAiloopCli(
        ["external-validation", "preflight", path.basename(repoDir)],
        path.dirname(repoDir)
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("External validation preflight: PASS");
      expect(result.stdout).toContain(`Repository: ${expectedRepoPath}`);
      expect(result.stdout).toContain("Detected test command: bun test");
      expect(result.stdout).toContain("Direct dependencies: 1");
      expect(result.stdout).toContain("Failure reasons: none");
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  test("prints failure reasons and exits non-zero for an ineligible candidate repository", async () => {
    const repoDir = await createExternalValidationCandidate({ includeTestInfrastructure: false });

    try {
      const expectedRepoPath = path.join(await fs.realpath(path.dirname(repoDir)), path.basename(repoDir));
      const result = runAiloopCli(
        ["external-validation", "preflight", path.basename(repoDir)],
        path.dirname(repoDir)
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("External validation preflight: FAIL");
      expect(result.stdout).toContain(`Repository: ${expectedRepoPath}`);
      expect(result.stdout).toContain("Detected test command: none");
      expect(result.stdout).toContain("Direct dependencies: 1");
      expect(result.stdout).toContain("Failure reasons:");
      expect(result.stdout).toContain(
        "- Repository must expose a local test entrypoint and matching test infrastructure."
      );
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});
