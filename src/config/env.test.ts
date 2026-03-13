import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./env";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true }))
  );
});

describe("loadConfig llm evaluator options", () => {
  test("uses defaults for domain-agnostic evaluator controls when no env overrides exist", () => {
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
      AILOOP_LLM_EVALUATOR_DIMENSIONS: "goal_alignment,causal_validity,constraint_compliance",
      AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE: "81",
      AILOOP_EVAL_REWORK_MAX_ATTEMPTS: "3"
    });

    expect(config.codex.llmEvaluatorDimensions).toEqual([
      "goal_alignment",
      "causal_validity",
      "constraint_compliance"
    ]);
    expect(config.codex.llmEvaluatorMinPassScore).toBe(81);
    expect(config.evaluatorReworkMaxAttempts).toBe(3);
  });

  test("prefers process env over default codex settings", () => {
    const config = loadConfig(
      {
        AILOOP_CODEX_BIN: "/tmp/override-codex"
      }
    );

    expect(config.codex.bin).toBe("/tmp/override-codex");
  });
});
