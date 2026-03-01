import { describe, expect, test } from "bun:test";
import { loadConfig } from "./env";

describe("loadConfig llm evaluator options", () => {
  test("uses defaults for domain-agnostic evaluator controls", () => {
    const config = loadConfig({});

    expect(config.codex.llmEvaluatorDimensions).toEqual([
      "goal_alignment",
      "causal_validity",
      "constraint_compliance",
      "risk_externality",
      "reversibility_resilience",
      "learning_yield"
    ]);
    expect(config.codex.llmEvaluatorMinPassScore).toBe(75);
    expect(config.evaluatorReworkMaxAttempts).toBe(1);
  });

  test("parses custom dimensions and threshold from env", () => {
    const config = loadConfig({
      AUTOLOOP_LLM_EVALUATOR_DIMENSIONS: "goal_alignment,causal_validity,constraint_compliance",
      AUTOLOOP_LLM_EVALUATOR_MIN_PASS_SCORE: "81",
      AUTOLOOP_EVAL_REWORK_MAX_ATTEMPTS: "3"
    });

    expect(config.codex.llmEvaluatorDimensions).toEqual([
      "goal_alignment",
      "causal_validity",
      "constraint_compliance"
    ]);
    expect(config.codex.llmEvaluatorMinPassScore).toBe(81);
    expect(config.evaluatorReworkMaxAttempts).toBe(3);
  });
});
