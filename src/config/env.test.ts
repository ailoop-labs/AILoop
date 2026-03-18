import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseManager } from "../utils/db";
import { loadConfig } from "./env";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
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

  test("defaults the model to a codex-compatible value when the provider bin is codex", () => {
    const config = loadConfig({
      AILOOP_AI_CLI_BIN: "codex"
    });

    expect(config.codex.model).toBe("gpt-5.4");
  });

  test("defaults the model to a claude-compatible value when the provider bin is claude", () => {
    const config = loadConfig({
      AILOOP_AI_CLI_BIN: "claude"
    });

    expect(config.codex.model).toBe("claude-opus-4-6");
  });

  test("loads config from the workspace database by default and ignores process env overrides", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-config-db-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    tempDirs.push(workspaceRoot);
    await fs.mkdir(homeDir, { recursive: true });

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });
    const previousAiBin = process.env.AILOOP_AI_CLI_BIN;

    try {
      await db.setConfig("AILOOP_AI_CLI_BIN", "/opt/homebrew/bin/claude");
      await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN", "db-token");
      await db.setConfig("AILOOP_INTERVAL_SECONDS", "45");

      process.env.AILOOP_AI_CLI_BIN = "codex";
      process.chdir(workspaceRoot);

      const config = loadConfig();

      expect(config.homeDir).toBe(await fs.realpath(homeDir));
      expect(config.codex.bin).toBe("/opt/homebrew/bin/claude");
      expect(config.consoleAdminToken).toBe("db-token");
      expect(config.intervalSeconds).toBe(45);
    } finally {
      db.close();
      if (previousAiBin === undefined) {
        delete process.env.AILOOP_AI_CLI_BIN;
      } else {
        process.env.AILOOP_AI_CLI_BIN = previousAiBin;
      }
    }
  });
});
