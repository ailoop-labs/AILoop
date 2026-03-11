import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import type { ActionRecord, EvaluationResult, SubTask, ToolResult } from "../types/contracts";
import { ensureLoopHome, type LoopPaths } from "./state";
import { LoopEngine } from "./engine";

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

test("writes a round summary artifact with round metadata and artifact references", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-summary-artifact-focused-test-"));
  const config = loadConfig({
    AILOOP_HOME: homeDir
  });
  const engine = new LoopEngine(config);
  const paths = (engine as unknown as { paths: LoopPaths }).paths;
  await ensureLoopHome(paths);

  const plan: SubTask = {
    assignee: "executor",
    rationale: "test rationale",
    objective: "Persist markdown round summary",
    expected_outcome: "round summary artifact exists with artifact references",
    impacted_files: [],
    recommended_tools: ["read_file", "run_shell"]
  };

  const execute = async () => ({
    actions: [makeAction("read_file"), makeAction("run_shell")],
    toolResult: makeToolResult("Created markdown summary artifact")
  });
  const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

  const mutable = engine as unknown as {
    planner: { plan: () => Promise<SubTask> };
    executor: { execute: typeof execute };
    evaluator: { evaluate: typeof evaluate };
    collectOperationalEvidence: () => Promise<{
      summaryNote: string;
      lines: string[];
      stateChangeNotes: string[];
    }>;
    runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
  };
  mutable.planner = { plan: async () => plan };
  mutable.executor = { execute };
  mutable.evaluator = { evaluate };
  mutable.collectOperationalEvidence = async () => ({
    summaryNote: "",
    lines: [],
    stateChangeNotes: []
  });

  const outcome = await mutable.runRound(1);

  expect(outcome.success).toBe(true);
  const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
  const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
  expect(summaryFile).toBeDefined();

  const summaryPath = path.join(homeDir, "runs", summaryFile as string);
  const summaryText = await fs.readFile(summaryPath, "utf8");

  expect(summaryText).toContain("# AILoop Round Summary");
  expect(summaryText).toContain("## Round Metadata");
  expect(summaryText).toContain("- Round: 1");
  expect(summaryText).toMatch(/- Timestamp: \d{4}-\d{2}-\d{2}T/);
  expect(summaryText).toContain("- Objective: Persist markdown round summary");
  expect(summaryText).toContain("- Tool Status: success");
  expect(summaryText).toContain("## Artifact References");
  expect(summaryText).toContain(`- Summary: ${summaryPath}`);
  expect(summaryText).toContain(
    `- Metrics: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.metrics.json"))}`
  );
  expect(summaryText).toContain(
    `- Log: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.log"))}`
  );
  expect(summaryText).toContain(
    `- State Change: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.state_change.txt"))}`
  );
  expect(summaryText).toContain(
    `- Evaluation: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.evaluation.json"))}`
  );
  expect(summaryText).toContain("- Decision: pass");

  await fs.rm(homeDir, { recursive: true, force: true });
});
