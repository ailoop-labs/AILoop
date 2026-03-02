import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildLoopPaths, defaultLoopState, hasFlag, setFlag, writeLoopState } from "./state";
import { ensureProjectRoles, getLoopStatus, prepareStartFlags, tailLatestLog } from "./control";
import type { AppConfig } from "../config/env";

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
    evaluatorType: "shell",
    evaluatorCmd: "",
    webhookEvaluatorUrl: "",
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
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-control-test-"));
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
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-tail-test-"));
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

describe("getLoopStatus", () => {
  test("recovers cooldown state to idle when process is not alive", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-status-cooldown-test-"));
    const paths = buildLoopPaths(homeDir);
    await fs.mkdir(homeDir, { recursive: true });

    const staleState = {
      ...defaultLoopState(),
      state: "cooldown" as const,
      pid: 999999
    };
    await writeLoopState(paths, staleState);

    const status = await getLoopStatus(makeTestConfig(homeDir));
    expect(status.state).toBe("idle");
    expect(status.pid).toBeNull();
    expect(status.pid_alive).toBe(false);
    expect(status.last_error).toContain("Process was not alive");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("ensureProjectRoles", () => {
  test("creates project role files when they are missing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-control-roles-test-"));
    const homeDir = path.join(workspaceRoot, ".autoloop");
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
