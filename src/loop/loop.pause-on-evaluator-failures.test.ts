import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import { LoopEngine } from "./engine";
import type { ActionRecord, EvaluationResult, SubTask, ToolResult } from "../types/contracts";
import { ensureLoopHome, readLoopState, setFlag, type LoopPaths } from "./state";

async function waitForPausedState(paths: LoopPaths, timeoutMs = 6_000): Promise<Awaited<ReturnType<typeof readLoopState>>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readLoopState(paths);
    if (state.state === "paused") {
      return state;
    }
    await Bun.sleep(50);
  }

  throw new Error("Timed out waiting for paused state.");
}

async function waitForLeaderInvocation(counter: () => number, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (counter() > 0) {
      return;
    }
    await Bun.sleep(25);
  }

  throw new Error("Timed out waiting for Leader invocation.");
}

function makeToolResult(summary: string): ToolResult {
  return {
    status: "success",
    summary,
    artifacts: {
      log_path: "",
      state_change_path: ""
    },
    next_state_hint: "continue"
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

describe("LoopEngine strategic evaluator pauses", () => {
  test("pauses and routes to governance on the first strategic evaluator failure", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-strategic-evaluator-pause-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Add evidence for evaluator handoff",
      expected_outcome: "The evaluator receives compact proof without needing another executor retry",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    let leaderInvocations = 0;
    let releaseLeader = () => {};
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      leader: {
        execute: () => Promise<{
          rationale: string;
          action: "stop";
          diagnosis_type: "implementation_failure";
          instructions: string[];
        }>;
      };
      run: () => Promise<void>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = {
      execute: async () => ({
        actions: [makeAction("write_file"), makeAction("run_shell")],
        toolResult: makeToolResult("Executor reports the targeted bun test passed with 61 pass, 0 fail.")
      })
    };
    mutable.evaluator = {
      evaluate: async () => ({
        decision: "fail",
        justification: "Insufficient evidence for key dimensions: goal_alignment, causal_validity, constraint_compliance.",
        root_cause: "insufficient_evidence:goal_alignment",
        evidence: ["No behavioral verification excerpt was attached."],
        recommended_next_action: "Attach minimal proof from the round artifacts.",
        recovery_path: "strategic_governance",
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "unknown",
            score: 58,
            confidence: 0.94,
            justification: "No compact verification excerpt proves the claimed behavior.",
            evidence: ["The executor summary is not enough on its own."],
            blocking_issues: ["Validation evidence is missing."],
            recommended_next_action: "Attach minimal proof."
          }
        ]
      })
    };
    mutable.leader = {
      execute: async () => {
        leaderInvocations += 1;
        await leaderGate;
        await setFlag(paths.stopFlagPath);
        return {
          rationale: "This is a strategic evidence-handoff problem.",
          action: "stop",
          diagnosis_type: "implementation_failure",
          instructions: []
        };
      }
    };

    let runPromise: Promise<void> | null = null;
    try {
      runPromise = mutable.run();
      const pausedState = await waitForPausedState(paths);
      await waitForLeaderInvocation(() => leaderInvocations);

      expect(leaderInvocations).toBe(1);
      expect(pausedState.last_error || "").toContain("EvaluatorStrategicBlock:");
      expect(pausedState.last_error || "").toContain("Insufficient evidence for key dimensions");
      expect(pausedState.consecutive_evaluator_failures).toBe(1);
    } finally {
      releaseLeader();
      await setFlag(paths.stopFlagPath);
      if (runPromise) {
        await Promise.race([
          runPromise,
          Bun.sleep(6_000).then(() => {
            throw new Error("Timed out stopping loop engine.");
          })
        ]);
      }
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("pauses and routes to governance when evaluator reports a no-mutation summary contradiction", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-contradiction-governance-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Keep the evaluator skeptical when round artifacts contradict the executor summary",
      expected_outcome: "The loop pauses for governance instead of trusting a no-mutation claim over artifact evidence",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    let leaderInvocations = 0;
    let releaseLeader = () => {};
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      leader: {
        execute: () => Promise<{
          rationale: string;
          action: "stop";
          diagnosis_type: "implementation_failure";
          instructions: string[];
        }>;
      };
      run: () => Promise<void>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = {
      execute: async () => ({
        actions: [makeAction("read_file"), makeAction("write_file"), makeAction("run_shell")],
        toolResult: makeToolResult("No code change was required; reran the targeted bun regression and confirmed it still passes.")
      })
    };
    mutable.evaluator = {
      evaluate: async () => ({
        decision: "fail",
        justification: "Executor summary conflicts with recorded round artifacts.",
        root_cause: "dimension_failure:goal_alignment",
        evidence: [
          "Executor summary claims no code change, but the state-change artifact records edits in src/evaluation/strategies/llm-judge.ts.",
          "round_inconsistency_summary.direct_evidence: src/evaluation/strategies/llm-judge.ts | @@ -1212,6 +1234,18 @@ | +      recovery_path: \"strategic_governance\","
        ],
        recommended_next_action: "pause and review the recorded file edits; do not trust the no-mutation summary",
        recovery_path: "tactical_rework",
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "fail",
            score: 24,
            confidence: 0.97,
            justification:
              "Executor summary claims no code change, but the state-change artifact records edits in src/evaluation/strategies/llm-judge.ts.",
            evidence: [
              "round_inconsistency_summary.direct_evidence: src/evaluation/strategies/llm-judge.ts | @@ -1212,6 +1234,18 @@ | +      recovery_path: \"strategic_governance\","
            ],
            blocking_issues: ["Do not trust the no-mutation summary until the contradiction is resolved."],
            recommended_next_action: "pause and review the recorded file edits"
          }
        ]
      })
    };
    mutable.leader = {
      execute: async () => {
        leaderInvocations += 1;
        await leaderGate;
        await setFlag(paths.stopFlagPath);
        return {
          rationale: "Artifact evidence contradicts the executor summary and requires governance review.",
          action: "stop",
          diagnosis_type: "implementation_failure",
          instructions: []
        };
      }
    };

    let runPromise: Promise<void> | null = null;
    try {
      runPromise = mutable.run();
      await waitForLeaderInvocation(() => leaderInvocations);
      const pausedState = await readLoopState(paths);

      expect(leaderInvocations).toBe(1);
      expect(pausedState.last_error || "").toContain("summary conflicts with recorded round artifacts");
      expect(pausedState.consecutive_evaluator_failures).toBe(1);
    } finally {
      releaseLeader();
      await setFlag(paths.stopFlagPath);
      if (runPromise) {
        await Promise.race([
          runPromise,
          Bun.sleep(6_000).then(() => {
            throw new Error("Timed out stopping loop engine.");
          })
        ]);
      }
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
