import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import type { SubTask } from "../types/contracts";
import { LoopEngine } from "./engine";
import { ensureLoopHome, readLoopState, type LoopPaths } from "./state";

describe("LoopEngine budget guard", () => {
  test("fails before planner execution when time budget is already exceeded", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-engine-budget-test-"));
    const config = loadConfig({
      AUTOLOOP_HOME: homeDir,
      AUTOLOOP_BUDGET_TIME_MINUTES: "-1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      rationale: "test",
      objective: "should not execute",
      expected_outcome: "should not execute",
      recommended_tools: ["read_file"]
    };

    let plannerCalls = 0;
    let executorCalls = 0;
    let evaluatorCalls = 0;

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: () => Promise<unknown> };
      evaluator: { evaluate: () => Promise<unknown> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        plannerCalls += 1;
        return plan;
      }
    };
    mutable.executor = {
      execute: async () => {
        executorCalls += 1;
        throw new Error("executor should not run");
      }
    };
    mutable.evaluator = {
      evaluate: async () => {
        evaluatorCalls += 1;
        throw new Error("evaluator should not run");
      }
    };

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toBe("BudgetBreach: time budget exceeded");
    expect(plannerCalls).toBe(0);
    expect(executorCalls).toBe(0);
    expect(evaluatorCalls).toBe(0);

    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const logFile = runArtifacts.find((entry) => entry.endsWith(".round.log"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(logFile).toBeDefined();
    expect(summaryFile).toBeDefined();

    const logText = await fs.readFile(path.join(homeDir, "runs", logFile as string), "utf8");
    expect(logText).toContain(
      "Budget guard blocked round.bootstrap (pre-action-time-guard): BudgetBreach: time budget exceeded"
    );

    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("BudgetBreach: time budget exceeded");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("records BudgetBreach failure with pause next_state_hint on pre-action time guard", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-engine-budget-hint-test-"));
    const config = loadConfig({
      AUTOLOOP_HOME: homeDir,
      AUTOLOOP_BUDGET_TIME_MINUTES: "-1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: () => Promise<unknown> };
      evaluator: { evaluate: () => Promise<unknown> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        throw new Error("planner should not run");
      }
    };
    mutable.executor = {
      execute: async () => {
        throw new Error("executor should not run");
      }
    };
    mutable.evaluator = {
      evaluate: async () => {
        throw new Error("evaluator should not run");
      }
    };

    const outcome = await mutable.runRound(1);
    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toBe("BudgetBreach: time budget exceeded");

    const state = await readLoopState(paths);
    expect(state.previous_tool_result?.status).toBe("failure");
    expect(state.previous_tool_result?.error?.type).toBe("BudgetBreach");
    expect(state.previous_tool_result?.next_state_hint).toBe("pause");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});
