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
      assignee: "executor",
      rationale: "test rationale",
      objective: "Update workspace snapshot handling",
      expected_outcome: "workspace snapshot tests pass",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    },
    toolResult: {
      status: "success",
      summary: "updated workspace snapshot",
      artifacts: {
        state_change_path: ".ailoop/runs/example.round.state_change.txt",
        log_path: ".ailoop/runs/example.round.log"
      },
      error: undefined,
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
    },
    onLog: async () => {}
  };
}

function makeLlmConfig(dimensions: AppConfig["codex"]["llmEvaluatorDimensions"] = ["goal_alignment"]): AppConfig {
  return {
    homeDir: "/tmp/ailoop-test",
    intervalSeconds: 1,
    maxCycles: 1,
    exitOnError: false,
    enableLeader: false,
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
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 20,
          justification: "Secret leakage detected in round artifacts.",
          evidence: ["Artifact log contains an unredacted API token."],
          blocking_issues: ["policy violation"],
          recommended_next_action: "rotate exposed token and redact stored artifacts"
        }),
        makeAssessment({ dimension: "risk_externality", score: 85 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Hard gate");
    expect(result.evidence.some((line) => line.includes("constraint_compliance detail:"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("unredacted API token"))).toBe(true);
    expect(result.recommended_next_action).toContain("rotate exposed token and redact stored artifacts");
  });

  test("fails with pause recommendation when key dimension is unknown", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({
          dimension: "goal_alignment",
          decision: "unknown",
          score: 0,
          justification: "No before/after KPI comparison was attached to the round.",
          evidence: ["State change artifact shows file edits only; no KPI output was logged."],
          recommended_next_action: "collect KPI evidence"
        }),
        makeAssessment({ dimension: "causal_validity", score: 78 }),
        makeAssessment({ dimension: "constraint_compliance", score: 92 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Insufficient evidence");
    expect(result.evidence.some((line) => line.includes("goal_alignment detail:"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("no KPI output was logged"))).toBe(true);
    expect(result.recommended_next_action).toContain("goal_alignment: collect KPI evidence");
    expect(result.recommended_next_action).toContain("pause");
  });

  test("surfaces Codex authentication failures as evaluator infrastructure blockers", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({
          dimension: "goal_alignment",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: [
            "Codex exited with code 1",
            "Error: 401 Unauthorized - incorrect API key provided while calling the evaluator model."
          ],
          recommended_next_action: "pause and inspect evaluator failure"
        }),
        makeAssessment({ dimension: "causal_validity", score: 81 }),
        makeAssessment({ dimension: "constraint_compliance", score: 90 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Evaluator infrastructure failure");
    expect(result.justification).toContain("Codex authentication failed");
    expect(result.root_cause).toBe("evaluator_infrastructure:codex_authentication");
    expect(result.evidence.some((line) => line.includes("401 Unauthorized"))).toBe(true);
    expect(result.recommended_next_action).toContain(".ailoop/codex-home/auth.json");
    expect(result.recommended_next_action).not.toContain("gather evidence");
  });

  test("surfaces concrete evidence and follow-up actions when a key dimension fails", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 88 }),
        makeAssessment({
          dimension: "causal_validity",
          decision: "fail",
          score: 35,
          justification: "The claimed impact is not supported by observed command output.",
          evidence: ["No test or metric output demonstrates the claimed behavior change."],
          recommended_next_action: "rerun targeted verification with before and after output"
        }),
        makeAssessment({ dimension: "constraint_compliance", score: 93 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("causal_validity");
    expect(result.evidence.some((line) => line.includes("causal_validity detail:"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("No test or metric output demonstrates"))).toBe(true);
    expect(result.recommended_next_action).toContain(
      "causal_validity: rerun targeted verification with before and after output"
    );
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

  test("redacts secret-like values before surfacing detailed evidence and follow-up actions", () => {
    const leakedApiKey = "sk-live-12345";
    const leakedSessionSecret = "super-secret-value";
    const leakedGithubToken = "ghp_secret_67890";

    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 91 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 5,
          justification: `Policy violation: OPENAI_API_KEY=${leakedApiKey} was written to evaluator output.`,
          evidence: [
            `artifact excerpt: SESSION_SECRET=${leakedSessionSecret}`,
            `log excerpt: GITHUB_TOKEN=${leakedGithubToken}`
          ],
          blocking_issues: [`rotate OPENAI_API_KEY=${leakedApiKey} and purge exposed logs`],
          recommended_next_action: `rotate SESSION_SECRET=${leakedSessionSecret} and GITHUB_TOKEN=${leakedGithubToken}`
        })
      ],
      75
    );

    const serialized = [result.justification, ...result.evidence, result.recommended_next_action].join("\n");

    expect(serialized).not.toContain(leakedApiKey);
    expect(serialized).not.toContain(leakedSessionSecret);
    expect(serialized).not.toContain(leakedGithubToken);
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(serialized).toContain("SESSION_SECRET=[REDACTED]");
    expect(serialized).toContain("GITHUB_TOKEN=[REDACTED]");
  });

  test("normalizes scores from 0-1 scale to 0-100 when all scores are low and at least one passed", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", decision: "pass", score: 1.0 }),
        makeAssessment({ dimension: "causal_validity", decision: "pass", score: 0.9 }),
        makeAssessment({ dimension: "constraint_compliance", decision: "pass", score: 0.95 })
      ],
      75
    );

    expect(result.decision).toBe("pass");
    expect(result.aggregateScore).toBeGreaterThanOrEqual(90);
    expect(result.evidence.some(e => e.includes("score=100.0"))).toBe(true);
    expect(result.evidence.some(e => e.includes("score=90.0"))).toBe(true);
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

  test("injects project-specific evaluator role definition block", () => {
    const context = makeRoundContext();
    const prompt = buildDimensionPrompt(
      "goal_alignment",
      context,
      "# Evaluator Role\n\nProject-specific evaluator instructions."
    );

    expect(prompt).toContain("Project-specific Evaluator Role Definition");
    expect(prompt).toContain("Project-specific evaluator instructions.");
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
