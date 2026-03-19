import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { EvaluationResult, SubTask } from "../types/contracts";
import type { RoundMetrics } from "./metrics";
import { buildExternalValidationMetricsReport, buildRoundSubTaskIdentity } from "./metrics";
import { buildRoundArtifactPaths } from "./summary";

const DEFAULT_EVALUATION: EvaluationResult = {
  decision: "pass",
  justification: "validated",
  evidence: ["regression coverage recorded"]
};

function makeSubTask(objective: string, expectedOutcome: string): SubTask {
  return {
    assignee: "executor",
    rationale: "Regression coverage for external validation reporting.",
    objective,
    expected_outcome: expectedOutcome,
    impacted_files: ["/Users/yinjames/projects/AILoop/src/reporting/metrics.test.ts"],
    recommended_tools: ["read_file", "write_file", "run_shell_command"]
  };
}

function makeMetrics(round: number, timestamp: string, subTask: SubTask): RoundMetrics {
  return {
    round,
    run_timestamp: timestamp,
    duration_ms: 1_000,
    budget_limits: {
      usdPerRound: 1,
      timeMinutes: 1,
      actions: 5
    },
    budget_usage: {
      usdUsed: 0.1,
      actionsUsed: 1,
      elapsedMs: 1_000
    },
    evaluator_decision: "pass",
    tool_status: "success",
    retries: {
      evidence_remediation_attempts: 0,
      auto_rework_attempts: 0,
      auto_rework_limit: 2
    },
    phase_timings_ms: {
      planning: 100,
      execution: 400,
      evaluation: 200,
      operational_followup: 300
    },
    human_interventions: 0,
    hot_file_growth_lines: 0,
    sub_task_identity: buildRoundSubTaskIdentity(subTask)
  };
}

async function writeRoundRecord(
  runsDir: string,
  options: {
    round: number;
    timestamp: string;
    subTask: SubTask;
    summary: string;
    stateChange: string;
  }
): Promise<void> {
  const artifacts = buildRoundArtifactPaths(runsDir, options.timestamp);
  const metrics = makeMetrics(options.round, options.timestamp, options.subTask);

  await Promise.all([
    fs.writeFile(artifacts.summaryPath, `${options.summary}\n`, "utf8"),
    fs.writeFile(artifacts.stateChangePath, options.stateChange, "utf8"),
    fs.writeFile(artifacts.metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8"),
    fs.writeFile(artifacts.evaluationPath, `${JSON.stringify(DEFAULT_EVALUATION, null, 2)}\n`, "utf8")
  ]);
}

describe("buildExternalValidationMetricsReport", () => {
  test("counts false no-op claims only when persisted state-change artifacts show concrete file edits", async () => {
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-metrics-test-"));
    const mismatchedSubTask = makeSubTask(
      "Count false no-op executor summaries against state-change artifacts.",
      "Mismatch rounds increment no_op_claim_mismatches."
    );
    const controlSubTask = makeSubTask(
      "Ignore truthful no-op executor summaries when no files changed.",
      "Matching no-op rounds do not increment no_op_claim_mismatches."
    );

    try {
      await writeRoundRecord(runsDir, {
        round: 1,
        timestamp: "2026-03-10T00-00-00-000Z",
        subTask: mismatchedSubTask,
        summary: "No workspace changes were required for this round.",
        stateChange: [
          "diff --git a/src/reporting/metrics.ts b/src/reporting/metrics.ts",
          "--- a/src/reporting/metrics.ts",
          "+++ b/src/reporting/metrics.ts",
          "@@ -1,3 +1,4 @@",
          " export async function buildExternalValidationMetricsReport() {",
          "+  return report;",
          " }"
        ].join("\n")
      });

      await writeRoundRecord(runsDir, {
        round: 2,
        timestamp: "2026-03-11T00-00-00-000Z",
        subTask: controlSubTask,
        summary: "No code changes were required for this round.",
        stateChange: "No state changes detected."
      });

      const report = await buildExternalValidationMetricsReport(runsDir);
      const mismatchTask = report.tasks.find(
        (task) => task.stable_id === buildRoundSubTaskIdentity(mismatchedSubTask).stable_id
      );
      const controlTask = report.tasks.find((task) => task.stable_id === buildRoundSubTaskIdentity(controlSubTask).stable_id);

      expect(report.task_count).toBe(2);
      expect(report.successful_task_count).toBe(2);

      expect(mismatchTask).toBeDefined();
      expect(mismatchTask?.rounds).toBe(1);
      expect(mismatchTask?.no_op_claim_mismatches).toBe(1);

      expect(controlTask).toBeDefined();
      expect(controlTask?.rounds).toBe(1);
      expect(controlTask?.no_op_claim_mismatches).toBe(0);
    } finally {
      await fs.rm(runsDir, { recursive: true, force: true });
    }
  });
});
