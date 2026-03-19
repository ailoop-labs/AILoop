import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { EvaluationResult, SubTask } from "../types/contracts";
import type { RoundMetrics } from "./metrics";
import {
  buildExternalValidationMetricsReport,
  buildRoundSubTaskIdentity,
  type ExternalValidationMetricsReport
} from "./metrics";
import { buildExternalValidationChecklistBaselineComparison } from "./external-validation";
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

function makeMetrics(round: number, timestamp: string, subTask: SubTask, usdUsed = 0.1): RoundMetrics {
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
      usdUsed,
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
    usdUsed?: number;
  }
): Promise<void> {
  const artifacts = buildRoundArtifactPaths(runsDir, options.timestamp);
  const metrics = makeMetrics(options.round, options.timestamp, options.subTask, options.usdUsed);

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

  test("aggregates stable-id scoped cost totals and per-round averages from persisted budget usage", async () => {
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-metrics-cost-test-"));
    const primarySubTask = makeSubTask(
      "Show external-validation cost by stable task identity.",
      "The report attributes cost totals only to the matching stable id."
    );
    const siblingSubTask = makeSubTask(
      "Show external-validation cost by stable task identity.",
      "A different stable id keeps its own independent cost totals."
    );

    try {
      await writeRoundRecord(runsDir, {
        round: 1,
        timestamp: "2026-03-12T00-00-00-000Z",
        subTask: primarySubTask,
        summary: "Recorded cost for the first retry.",
        stateChange: "No state changes detected.",
        usdUsed: 0.12
      });

      await writeRoundRecord(runsDir, {
        round: 2,
        timestamp: "2026-03-13T00-00-00-000Z",
        subTask: primarySubTask,
        summary: "Recorded cost for the second retry.",
        stateChange: "No state changes detected.",
        usdUsed: 0.18
      });

      await writeRoundRecord(runsDir, {
        round: 3,
        timestamp: "2026-03-14T00-00-00-000Z",
        subTask: siblingSubTask,
        summary: "Recorded cost for a different stable task identity.",
        stateChange: "No state changes detected.",
        usdUsed: 0.8
      });

      const report = await buildExternalValidationMetricsReport(runsDir);
      const primaryTask = report.tasks.find((task) => task.stable_id === buildRoundSubTaskIdentity(primarySubTask).stable_id);
      const siblingTask = report.tasks.find((task) => task.stable_id === buildRoundSubTaskIdentity(siblingSubTask).stable_id);

      expect(report.task_count).toBe(2);
      expect(primaryTask).toBeDefined();
      expect(primaryTask?.rounds).toBe(2);
      expect(primaryTask?.total_cost_usd).toBe(0.3);
      expect(primaryTask?.average_cost_usd_per_round).toBe(0.15);
      expect(report.checklist.rounds_per_successful_task).toBe(1.5);
      expect(report.checklist.human_interventions_per_task).toBe(0);
      expect(report.checklist.average_cost_usd_per_round).toBe(0.366667);
      expect(report.checklist.evaluator_infrastructure_failures).toBe(0);
      expect(report.checklist.hot_file_growth_lines).toBe(0);

      expect(siblingTask).toBeDefined();
      expect(siblingTask?.rounds).toBe(1);
      expect(siblingTask?.total_cost_usd).toBe(0.8);
      expect(siblingTask?.average_cost_usd_per_round).toBe(0.8);
    } finally {
      await fs.rm(runsDir, { recursive: true, force: true });
    }
  });

  test("builds aggregate checklist metrics from persisted round artifacts", async () => {
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-metrics-checklist-test-"));
    const successfulTask = makeSubTask(
      "Summarize successful external-validation checklist metrics.",
      "The checklist report shows aggregate rounds, interventions, cost, infra failures, and hot-file growth."
    );
    const unsuccessfulTask = makeSubTask(
      "Keep unsuccessful rounds out of successful-task averages.",
      "Failed-only tasks do not affect rounds per successful task."
    );

    try {
      const firstSuccessArtifacts = buildRoundArtifactPaths(runsDir, "2026-03-15T00-00-00-000Z");
      const firstSuccessMetrics = makeMetrics(1, "2026-03-15T00:00:00.000Z", successfulTask, 0.12);
      firstSuccessMetrics.evaluator_decision = "fail";
      firstSuccessMetrics.human_interventions = 1;
      firstSuccessMetrics.hot_file_growth_lines = 2;

      const secondSuccessArtifacts = buildRoundArtifactPaths(runsDir, "2026-03-16T00-00-00-000Z");
      const secondSuccessMetrics = makeMetrics(2, "2026-03-16T00:00:00.000Z", successfulTask, 0.18);
      secondSuccessMetrics.evaluator_decision = "pass";
      secondSuccessMetrics.human_interventions = 2;
      secondSuccessMetrics.hot_file_growth_lines = 3;

      const unsuccessfulArtifacts = buildRoundArtifactPaths(runsDir, "2026-03-17T00-00-00-000Z");
      const unsuccessfulMetrics = makeMetrics(3, "2026-03-17T00:00:00.000Z", unsuccessfulTask, 0.3);
      unsuccessfulMetrics.evaluator_decision = "fail";
      unsuccessfulMetrics.human_interventions = 1;
      unsuccessfulMetrics.hot_file_growth_lines = 4;

      await Promise.all([
        fs.writeFile(firstSuccessArtifacts.summaryPath, "Initial retry captured.\n", "utf8"),
        fs.writeFile(firstSuccessArtifacts.stateChangePath, "No state changes detected.", "utf8"),
        fs.writeFile(firstSuccessArtifacts.metricsPath, `${JSON.stringify(firstSuccessMetrics, null, 2)}\n`, "utf8"),
        fs.writeFile(
          firstSuccessArtifacts.evaluationPath,
          `${JSON.stringify(
            {
              decision: "fail",
              justification: "One more bounded round required.",
              evidence: []
            } satisfies EvaluationResult,
            null,
            2
          )}\n`,
          "utf8"
        ),
        fs.writeFile(secondSuccessArtifacts.summaryPath, "Success round recorded.\n", "utf8"),
        fs.writeFile(secondSuccessArtifacts.stateChangePath, "No state changes detected.", "utf8"),
        fs.writeFile(secondSuccessArtifacts.metricsPath, `${JSON.stringify(secondSuccessMetrics, null, 2)}\n`, "utf8"),
        fs.writeFile(
          secondSuccessArtifacts.evaluationPath,
          `${JSON.stringify(
            {
              decision: "pass",
              justification: "Validated successfully.",
              evidence: []
            } satisfies EvaluationResult,
            null,
            2
          )}\n`,
          "utf8"
        ),
        fs.writeFile(unsuccessfulArtifacts.summaryPath, "Infra failure recorded.\n", "utf8"),
        fs.writeFile(unsuccessfulArtifacts.stateChangePath, "No state changes detected.", "utf8"),
        fs.writeFile(unsuccessfulArtifacts.metricsPath, `${JSON.stringify(unsuccessfulMetrics, null, 2)}\n`, "utf8"),
        fs.writeFile(
          unsuccessfulArtifacts.evaluationPath,
          `${JSON.stringify(
            {
              decision: "fail",
              justification: "Evaluator infrastructure failure: timeout while judging round.",
              root_cause: "evaluator_infrastructure:timeout",
              evidence: []
            } satisfies EvaluationResult,
            null,
            2
          )}\n`,
          "utf8"
        )
      ]);

      const report = await buildExternalValidationMetricsReport(runsDir);

      expect(report.task_count).toBe(2);
      expect(report.successful_task_count).toBe(1);
      expect(report.checklist.rounds_per_successful_task).toBe(2);
      expect(report.checklist.human_interventions_per_task).toBe(2);
      expect(report.checklist.average_cost_usd_per_round).toBe(0.2);
      expect(report.checklist.evaluator_infrastructure_failures).toBe(1);
      expect(report.checklist.hot_file_growth_lines).toBe(9);
    } finally {
      await fs.rm(runsDir, { recursive: true, force: true });
    }
  });

  test("keeps shared aggregate metrics payload free of baseline-only presentation fields", async () => {
    const pilotRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-metrics-pilot-baseline-test-"));
    const baselineRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-metrics-self-iteration-baseline-test-"));
    const comparedTask = makeSubTask(
      "Compare pilot checklist metrics against a self-iteration baseline.",
      "The report records baseline, pilot, and delta values for the documented checklist metrics."
    );

    try {
      const baselineArtifacts = buildRoundArtifactPaths(baselineRunsDir, "2026-03-18T00-00-00-000Z");
      const baselineMetrics = makeMetrics(1, "2026-03-18T00:00:00.000Z", comparedTask, 0.05);
      baselineMetrics.evaluator_decision = "pass";
      baselineMetrics.human_interventions = 1;
      baselineMetrics.hot_file_growth_lines = 2;

      const pilotFirstArtifacts = buildRoundArtifactPaths(pilotRunsDir, "2026-03-19T00-00-00-000Z");
      const pilotFirstMetrics = makeMetrics(1, "2026-03-19T00:00:00.000Z", comparedTask, 0.1);
      pilotFirstMetrics.evaluator_decision = "fail";
      pilotFirstMetrics.human_interventions = 1;
      pilotFirstMetrics.hot_file_growth_lines = 3;

      const pilotSecondArtifacts = buildRoundArtifactPaths(pilotRunsDir, "2026-03-19T00-05-00-000Z");
      const pilotSecondMetrics = makeMetrics(2, "2026-03-19T00:05:00.000Z", comparedTask, 0.3);
      pilotSecondMetrics.evaluator_decision = "pass";
      pilotSecondMetrics.human_interventions = 1;
      pilotSecondMetrics.hot_file_growth_lines = 3;

      await Promise.all([
        fs.writeFile(baselineArtifacts.summaryPath, "Baseline success recorded.\n", "utf8"),
        fs.writeFile(baselineArtifacts.stateChangePath, "No state changes detected.", "utf8"),
        fs.writeFile(baselineArtifacts.metricsPath, `${JSON.stringify(baselineMetrics, null, 2)}\n`, "utf8"),
        fs.writeFile(
          baselineArtifacts.evaluationPath,
          `${JSON.stringify(
            {
              decision: "pass",
              justification: "Baseline completed successfully.",
              evidence: []
            } satisfies EvaluationResult,
            null,
            2
          )}\n`,
          "utf8"
        ),
        fs.writeFile(pilotFirstArtifacts.summaryPath, "Pilot retry recorded.\n", "utf8"),
        fs.writeFile(pilotFirstArtifacts.stateChangePath, "No state changes detected.", "utf8"),
        fs.writeFile(pilotFirstArtifacts.metricsPath, `${JSON.stringify(pilotFirstMetrics, null, 2)}\n`, "utf8"),
        fs.writeFile(
          pilotFirstArtifacts.evaluationPath,
          `${JSON.stringify(
            {
              decision: "fail",
              justification: "Evaluator infrastructure failure: upstream timeout while judging the pilot round.",
              root_cause: "evaluator_infrastructure:upstream_timeout",
              evidence: []
            } satisfies EvaluationResult,
            null,
            2
          )}\n`,
          "utf8"
        ),
        fs.writeFile(pilotSecondArtifacts.summaryPath, "Pilot success recorded.\n", "utf8"),
        fs.writeFile(pilotSecondArtifacts.stateChangePath, "No state changes detected.", "utf8"),
        fs.writeFile(pilotSecondArtifacts.metricsPath, `${JSON.stringify(pilotSecondMetrics, null, 2)}\n`, "utf8"),
        fs.writeFile(
          pilotSecondArtifacts.evaluationPath,
          `${JSON.stringify(
            {
              decision: "pass",
              justification: "Pilot completed successfully.",
              evidence: []
            } satisfies EvaluationResult,
            null,
            2
          )}\n`,
          "utf8"
        )
      ]);

      const report = await buildExternalValidationMetricsReport(pilotRunsDir);
      const baselineComparison = await buildExternalValidationChecklistBaselineComparison(
        report.checklist,
        baselineRunsDir
      );

      expect(Object.prototype.hasOwnProperty.call(report as ExternalValidationMetricsReport, "baseline_comparison")).toBe(
        false
      );
      expect(baselineComparison).toEqual({
        baseline_runs_dir: baselineRunsDir,
        checklist: {
          rounds_per_successful_task: {
            baseline: 1,
            pilot: 2,
            delta: 1
          },
          human_interventions_per_task: {
            baseline: 1,
            pilot: 2,
            delta: 1
          },
          average_cost_usd_per_round: {
            baseline: 0.05,
            pilot: 0.2,
            delta: 0.15
          },
          evaluator_infrastructure_failures: {
            baseline: 0,
            pilot: 1,
            delta: 1
          },
          hot_file_growth_lines: {
            baseline: 2,
            pilot: 6,
            delta: 4
          }
        }
      });
    } finally {
      await fs.rm(pilotRunsDir, { recursive: true, force: true });
      await fs.rm(baselineRunsDir, { recursive: true, force: true });
    }
  });
});
