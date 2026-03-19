import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { RoundEvaluationContext } from "../../types/contracts";
import { DatabaseManager } from "../../utils/db";
import { buildValidationHandoff } from "../validation-handoff";
import { UIEvaluator } from "./ui-evaluator";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  delete process.env.AILOOP_UI_EVALUATOR_CMD;
});

function makeEvaluationContext(): RoundEvaluationContext {
  const context: RoundEvaluationContext = {
    subTask: {
      rationale: "verify ui",
      assignee: "designer",
      objective: "run ui evaluator",
      expected_outcome: "visual checks pass",
      impacted_files: [],
      recommended_tools: []
    },
    toolResult: {
      status: "success",
      summary: "rendered ui",
      artifacts: {
        log_path: "round.log",
        state_change_path: "state-change.txt"
      }
    },
    stateChange: "updated ui",
    logLines: [],
    runTimestamp: new Date().toISOString(),
    budgetLimits: {
      usdPerRound: 1,
      timeMinutes: 1,
      actions: 1
    },
    budgetUsage: {
      usdUsed: 0,
      elapsedMs: 0,
      actionsUsed: 0
    },
    validation_handoff: {} as RoundEvaluationContext["validation_handoff"],
    onLog() {}
  };

  context.validation_handoff = buildValidationHandoff(context);
  return context;
}

describe("UIEvaluator", () => {
  test("reads the configured UI evaluator command from the workspace database", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ui-evaluator-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    tempDirs.add(workspaceRoot);
    await fs.mkdir(homeDir, { recursive: true });

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });
    try {
      await db.setConfig("AILOOP_UI_EVALUATOR_CMD", "printf 'db-ui-check\\n'");
      process.env.AILOOP_UI_EVALUATOR_CMD = "printf 'env-ui-check\\n'";

      const evaluator = new UIEvaluator(homeDir);
      const result = await evaluator.evaluate(makeEvaluationContext());

      expect(result.decision).toBe("pass");
      expect(result.evidence).toContain("db-ui-check");
      expect(result.evidence).not.toContain("env-ui-check");
    } finally {
      db.close();
    }
  });
});
