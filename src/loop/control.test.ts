import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildLoopPaths, defaultLoopState, hasFlag, readLoopState, setFlag, writeLoopState } from "./state";
import {
  ensureProjectRoles,
  getCliStatus,
  getLoopStatus,
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
});

describe("getLoopStatus", () => {
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
