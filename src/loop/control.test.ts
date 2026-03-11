import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
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
  tailLatestLog
} from "./control";
import type { AppConfig } from "../config/env";
import { saveRuntimeLoopConfig } from "../config/runtime";

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
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      "",
      'const homeDir = path.join(process.cwd(), ".ailoop");',
      'const statePath = path.join(homeDir, "state.json");',
      "await Bun.sleep(150);",
      'const current = JSON.parse(await fs.readFile(statePath, "utf8"));',
      "const updatedAt = new Date().toISOString();",
      "await fs.writeFile(",
      "  statePath,",
      "  `${JSON.stringify({",
      "    ...current,",
      '    state: "running",',
      "    pid: process.pid,",
      "    last_error: null,",
      "    updated_at: updatedAt",
      "  }, null, 2)}\\n`,",
      '  "utf8"',
      ");",
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
});

describe("getRunArtifacts", () => {
  test("returns the full artifact bundle for a specific completed run", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-test-"));
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
      state_change: "+ SESSION_SECRET=[REDACTED]\n"
    });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("redacts mixed-case secret assignments from archived run artifacts at serve time", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-run-artifacts-redaction-test-"));
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
        state_change: "+ apiToken=[REDACTED]\n"
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
});

describe("getLoopStatus", () => {
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
            executor_role_md: "# Executor Role\n\nGenerated",
            evaluator_role_md: "# Evaluator Role\n\nGenerated"
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
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nCustom executor\n", "utf8");

    const roles = await listProjectRoles(makeTestConfig(homeDir));

    expect(roles.length).toBe(3);
    expect(roles.map((role) => role.role)).toEqual(["planner", "executor", "evaluator"]);
    expect(roles[0]?.definition).toContain("Custom planner");
    expect(roles[1]?.definition).toContain("Custom executor");
    expect(roles[2]?.definition).toContain("Project Evaluator Role");
    expect(typeof roles[2]?.exists).toBe("boolean");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});
