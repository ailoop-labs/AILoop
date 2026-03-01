import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../config/env";
import type { DimensionAssessment, RoundEvaluationContext } from "../../types/contracts";
import { LLMJudgeEvaluator, aggregateDimensionAssessments, buildDimensionPrompt } from "./llm-judge";

function makeAssessment(partial: Partial<DimensionAssessment> & Pick<DimensionAssessment, "dimension">): DimensionAssessment {
  return {
    dimension: partial.dimension,
    decision: partial.decision ?? "pass",
    score: partial.score ?? 80,
    confidence: partial.confidence ?? 0.8,
    justification: partial.justification ?? "ok",
    evidence: partial.evidence ?? ["evidence"],
    blocking_issues: partial.blocking_issues ?? [],
    recommended_next_action: partial.recommended_next_action ?? "continue"
  };
}

function makeRoundContext(): RoundEvaluationContext {
  return {
    subTask: {
      rationale: "test rationale",
      objective: "Update workspace snapshot handling",
      expected_outcome: "workspace snapshot tests pass",
      recommended_tools: ["read_file", "write_file", "run_shell"]
    },
    toolResult: {
      status: "success",
      summary: "updated workspace snapshot",
      artifacts: {
        state_change_path: ".autoloop/runs/example.round.state_change.txt",
        log_path: ".autoloop/runs/example.round.log"
      },
      error: null,
      next_state_hint: "continue"
    },
    stateChange: "diff --git a/src/environment/workspace.ts b/src/environment/workspace.ts",
    logLines: ["executor started", "executor finished"],
    runTimestamp: "2026-03-01T00:00:00.000Z",
    budgetLimits: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    budgetUsage: {
      usdUsed: 0.05,
      actionsUsed: 5,
      elapsedMs: 5000
    }
  };
}

function makeLlmConfig(dimensions: AppConfig["codex"]["llmEvaluatorDimensions"] = ["goal_alignment"]): AppConfig {
  return {
    homeDir: "/tmp/autoloop-test",
    intervalSeconds: 1,
    maxCycles: 1,
    exitOnError: false,
    evaluatorReworkMaxAttempts: 1,
    consoleHost: "127.0.0.1",
    consolePort: 3090,
    consoleAdminToken: "",
    maxRetainRuns: 10,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    evaluatorType: "llm",
    evaluatorCmd: "",
    webhookEvaluatorUrl: "",
    codex: {
      bin: "codex",
      model: "",
      profile: "",
      plannerSandbox: "read-only",
      executorSandbox: "workspace-write",
      evaluatorSandbox: "workspace-write",
      timeoutMs: 30_000,
      llmEvaluatorDimensions: dimensions,
      llmEvaluatorMinPassScore: 70
    }
  };
}

describe("aggregateDimensionAssessments", () => {
  test("fails immediately when constraint_compliance fails", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 90 }),
        makeAssessment({ dimension: "constraint_compliance", decision: "fail", score: 20, blocking_issues: ["policy violation"] }),
        makeAssessment({ dimension: "risk_externality", score: 85 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Hard gate");
    expect(result.recommended_next_action).toContain("policy violation");
  });

  test("fails with pause recommendation when key dimension is unknown", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", decision: "unknown", score: 0, recommended_next_action: "collect KPI evidence" }),
        makeAssessment({ dimension: "causal_validity", score: 78 }),
        makeAssessment({ dimension: "constraint_compliance", score: 92 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Insufficient evidence");
    expect(result.recommended_next_action).toContain("pause");
  });

  test("passes when weighted score meets threshold and no blockers", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 85 }),
        makeAssessment({ dimension: "causal_validity", score: 82 }),
        makeAssessment({ dimension: "constraint_compliance", score: 90 }),
        makeAssessment({ dimension: "risk_externality", score: 80 }),
        makeAssessment({ dimension: "reversibility_resilience", score: 75 }),
        makeAssessment({ dimension: "learning_yield", score: 72 })
      ],
      75
    );

    expect(result.decision).toBe("pass");
    expect(result.aggregateScore).toBeGreaterThanOrEqual(75);
  });

  test("treats scope-only file-range overflow as non-blocking signal", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 92 }),
        makeAssessment({ dimension: "causal_validity", score: 88 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 20,
          justification: "Unrelated file mutations indicate hidden scope expansion beyond the declared sub-task.",
          blocking_issues: ["Unrelated file mutations indicate hidden scope expansion beyond the declared sub-task."]
        }),
        makeAssessment({ dimension: "risk_externality", score: 84 }),
        makeAssessment({ dimension: "reversibility_resilience", score: 81 }),
        makeAssessment({ dimension: "learning_yield", score: 76 })
      ],
      75
    );

    expect(result.decision).toBe("pass");
    expect(result.justification).not.toContain("Hard gate");
    expect(result.recommended_next_action).toBe("continue");
  });

  test("keeps hard gate failure for concrete policy violations", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 90 }),
        makeAssessment({ dimension: "causal_validity", score: 85 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 15,
          justification: "Policy violation: secret token was logged in clear text.",
          blocking_issues: ["Policy violation: secret token exposed in artifacts."]
        }),
        makeAssessment({ dimension: "risk_externality", score: 83 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Hard gate");
    expect(result.recommended_next_action).toContain("Policy violation");
  });
});

describe("buildDimensionPrompt", () => {
  test("includes scope-only vs concrete-risk decision examples for hard-gate dimensions", () => {
    const context = makeRoundContext();
    const prompt = buildDimensionPrompt("constraint_compliance", context);

    expect(prompt).toContain("Decision examples");
    expect(prompt).toContain("scope-only");
    expect(prompt).toContain("policy/budget/safety");
    expect(prompt).toContain("Evidence priority");
    expect(prompt).toContain("behavioral verification");
    expect(prompt).toContain("structural scope signal");
  });
});

describe("LLMJudgeEvaluator logging", () => {
  test("emits evaluator progress and streamed codex output to onLog", async () => {
    const logs: string[] = [];
    const context: RoundEvaluationContext = {
      ...makeRoundContext(),
      onLog: (message) => {
        logs.push(message);
      }
    };

    const mockCodex = {
      async runJson<T>(options: { onStdoutChunk?: (chunk: string) => void; onStderrChunk?: (chunk: string) => void }) {
        options.onStdoutChunk?.("stdout from evaluator\n");
        options.onStderrChunk?.("stderr from evaluator\n");
        return {
          ok: true,
          data: {
            dimension: "goal_alignment",
            decision: "pass",
            score: 90,
            confidence: 0.9,
            justification: "ok",
            evidence: ["evidence"],
            blocking_issues: [],
            recommended_next_action: "continue"
          } as unknown as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const evaluator = new LLMJudgeEvaluator(makeLlmConfig(), mockCodex as never);
    const result = await evaluator.evaluate(context);

    expect(result.decision).toBe("pass");
    expect(logs.some((line) => line.includes("Evaluator started LLM dimension checks"))).toBe(true);
    expect(logs.some((line) => line.includes("Evaluator checking dimension: goal_alignment"))).toBe(true);
    expect(logs.some((line) => line.includes("[evaluator codex stdout] stdout from evaluator"))).toBe(true);
    expect(logs.some((line) => line.includes("[evaluator codex stderr] stderr from evaluator"))).toBe(true);
  });
});
