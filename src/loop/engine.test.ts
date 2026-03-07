import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import type { ActionRecord, EvaluationResult, SubTask, ToolResult } from "../types/contracts";
import { ensureLoopHome, readLoopState, type LoopPaths, writeLoopState } from "./state";
import { LoopEngine, extractSnapshotTargetsFromSubTask, resolveNextLastError } from "./engine";

function makeToolResult(summary: string): ToolResult {
  return {
    status: "success",
    summary,
    artifacts: {
      log_path: "",
      state_change_path: ""
    },
    error: null,
    next_state_hint: "continue"
  };
}

function makeEvaluation(decision: EvaluationResult["decision"], justification: string): EvaluationResult {
  return {
    decision,
    justification,
    evidence: ["test-evidence"],
    recommended_next_action: "add targeted verification"
  };
}

function makeAction(tool: string): ActionRecord {
  return {
    tool,
    args: {},
    ok: true,
    output: `${tool} ok`
  };
}

describe("extractSnapshotTargetsFromSubTask", () => {
  test("extracts backticked file paths from objective and outcome", () => {
    const workspaceRoot = "/tmp/workspace";
    const subTask: SubTask = {
      rationale: "test",
      objective: "Create `.ailoop/plans/round-7.md` with checklist.",
      expected_outcome: "File `src/loop/engine.ts` updated and `.ailoop/runs/report.txt` written.",
      recommended_tools: ["write_file"]
    };

    const targets = extractSnapshotTargetsFromSubTask(subTask, workspaceRoot);
    expect(targets).toContain(path.join(workspaceRoot, ".ailoop/plans/round-7.md"));
    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.ts"));
    expect(targets).toContain(path.join(workspaceRoot, ".ailoop/runs/report.txt"));
  });
});

describe("resolveNextLastError", () => {
  test("preserves previous error when transition does not provide one", () => {
    expect(resolveNextLastError("blocked", undefined)).toBe("blocked");
  });

  test("allows explicit clear when transition sets null", () => {
    expect(resolveNextLastError("blocked", null)).toBeNull();
  });

  test("writes explicit next error message when provided", () => {
    expect(resolveNextLastError("blocked", "new-error")).toBe("new-error");
  });
});

describe("LoopEngine auto rework", () => {
  test("retries once after evaluator fail by feeding failure reason back to executor", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-rework-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_EVAL_REWORK_MAX_ATTEMPTS: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      rationale: "test rationale",
      objective: "Implement one change",
      expected_outcome: "one verification passes",
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    const executorInputs: Array<{ subTask: SubTask; instructions: string[] }> = [];
    const execute = async (input: { subTask: SubTask; instructions: string[] }) => {
      executorInputs.push(input);
      if (executorInputs.length === 1) {
        return {
          actions: [makeAction("read_file")],
          toolResult: makeToolResult("initial change")
        };
      }
      return {
        actions: [makeAction("write_file"), makeAction("run_shell")],
        toolResult: makeToolResult("rework change")
      };
    };

    let evalCall = 0;
    const evaluate = async (): Promise<EvaluationResult> => {
      evalCall += 1;
      if (evalCall === 1) {
        return makeEvaluation("fail", "Missing negative tests for edge cases.");
      }
      return makeEvaluation("pass", "All checks satisfied.");
    };

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    expect(executorInputs.length).toBe(2);
    expect(evalCall).toBe(2);
    expect(executorInputs[1]?.instructions.join("\n")).toContain("Evaluator failure");
    expect(executorInputs[1]?.instructions.join("\n")).toContain("Missing negative tests");
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();
    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("## Auto Rework Attempts");
    expect(summaryText).toContain("Attempt 1/1:");
    expect(summaryText).toContain("trigger='Missing negative tests for edge cases.'");
    expect(summaryText).toContain("evaluation=pass");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("LoopEngine time budget guard", () => {
  test("pauses before next action when elapsed round time exceeds limit", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-time-guard-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_BUDGET_TIME_MINUTES: "0.001" // 60ms
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      rationale: "test rationale",
      objective: "Execute bounded task",
      expected_outcome: "executor runs after planning",
      recommended_tools: ["read_file", "run_shell"]
    };

    let executorCalls = 0;
    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: () => Promise<{ actions: ActionRecord[]; toolResult: ToolResult }> };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        await Bun.sleep(80);
        return plan;
      }
    };
    mutable.executor = {
      execute: async () => {
        executorCalls += 1;
        return {
          actions: [makeAction("run_shell")],
          toolResult: makeToolResult("executor should not run when time budget is exceeded")
        };
      }
    };
    mutable.evaluator = {
      evaluate: async () => makeEvaluation("pass", "unused")
    };

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toContain("BudgetBreach: time budget exceeded");
    expect(executorCalls).toBe(0);

    const state = await readLoopState(paths);
    expect(state.state).toBe("paused");
    expect(state.last_error).toContain("BudgetBreach: time budget exceeded");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("LoopEngine round error handling", () => {
  test("preserves seeded evaluator failure count on pre-evaluation execution errors", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-round-error-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    const seededState = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seededState,
      consecutive_evaluator_failures: 2
    });

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        // Simulate an intermediate state write before the round errors out.
        const midRoundState = await readLoopState(paths);
        await writeLoopState(paths, {
          ...midRoundState,
          consecutive_evaluator_failures: 9
        });
        throw new Error("planner exploded before execution");
      }
    };

    const outcome = await mutable.runRound(1);
    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toBe("planner exploded before execution");

    const state = await readLoopState(paths);
    expect(state.previous_tool_result?.status).toBe("failure");
    expect(state.previous_tool_result?.error?.type).toBe("RoundExecutionError");
    expect(state.previous_tool_result?.next_state_hint).toBe("continue");
    expect(state.consecutive_evaluator_failures).toBe(9);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});
