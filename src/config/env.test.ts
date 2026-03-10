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

  test("reads codex bin from .env when process env does not provide it", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-env-test-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, ".env"), "AILOOP_CODEX_BIN=/tmp/test-codex\n", "utf8");

    const config = loadConfig({}, { cwd });

    expect(config.codex.bin).toBe("/tmp/test-codex");
  });

  test("prefers process env over .env codex settings", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-env-test-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, ".env"), "AILOOP_CODEX_BIN=/tmp/test-codex\n", "utf8");

    const config = loadConfig(
      {
        AILOOP_CODEX_BIN: "/tmp/override-codex"
      },
      { cwd }
    );

    expect(config.codex.bin).toBe("/tmp/override-codex");
  });
});
