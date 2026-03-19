import type {
  ExternalValidationChecklistBaselineComparison,
  ExternalValidationChecklistMetricComparison,
  ExternalValidationChecklistMetrics,
  ExternalValidationMetricsReport
} from "../types/contracts";
import { buildExternalValidationMetricsReport } from "./metrics";

function normalizeAverage(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeUsd(value: number): number {
  return Number(value.toFixed(6));
}

function buildChecklistMetricComparison(
  pilot: number | null,
  baseline: number | null,
  normalizeDelta: (value: number) => number = normalizeAverage
): ExternalValidationChecklistMetricComparison {
  return {
    baseline,
    pilot,
    delta: pilot === null || baseline === null ? null : normalizeDelta(pilot - baseline)
  };
}

export async function buildExternalValidationChecklistBaselineComparison(
  pilotChecklist: ExternalValidationChecklistMetrics,
  baselineRunsDir: string
): Promise<ExternalValidationChecklistBaselineComparison> {
  const baselineReport = await buildExternalValidationMetricsReport(baselineRunsDir);
  return {
    baseline_runs_dir: baselineRunsDir,
    checklist: {
      rounds_per_successful_task: buildChecklistMetricComparison(
        pilotChecklist.rounds_per_successful_task,
        baselineReport.checklist.rounds_per_successful_task
      ),
      human_interventions_per_task: buildChecklistMetricComparison(
        pilotChecklist.human_interventions_per_task,
        baselineReport.checklist.human_interventions_per_task
      ),
      average_cost_usd_per_round: buildChecklistMetricComparison(
        pilotChecklist.average_cost_usd_per_round,
        baselineReport.checklist.average_cost_usd_per_round,
        normalizeUsd
      ),
      evaluator_infrastructure_failures: buildChecklistMetricComparison(
        pilotChecklist.evaluator_infrastructure_failures,
        baselineReport.checklist.evaluator_infrastructure_failures
      ),
      hot_file_growth_lines: buildChecklistMetricComparison(
        pilotChecklist.hot_file_growth_lines,
        baselineReport.checklist.hot_file_growth_lines
      )
    }
  };
}

function formatUsd(value: number): string {
  return value.toFixed(4);
}

function formatAverage(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function formatCount(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatDelta(value: number | null, formatter: (value: number | null) => string): string {
  if (value === null) {
    return "n/a";
  }

  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatter(Math.abs(value))}`;
}

function formatChecklistComparisonLine(
  label: string,
  metric: ExternalValidationChecklistMetricComparison,
  formatter: (value: number | null) => string
): string {
  return `- ${label}: baseline=${formatter(metric.baseline)} | pilot=${formatter(metric.pilot)} | delta=${formatDelta(metric.delta, formatter)}`;
}

export function renderExternalValidationMetricsReport(
  metrics: ExternalValidationMetricsReport,
  baselineComparison?: ExternalValidationChecklistBaselineComparison
): string {
  const lines = [
    "External validation metrics report",
    `Tasks analyzed: ${metrics.task_count}`,
    `Successful tasks: ${metrics.successful_task_count}`,
    "Verification checklist summary:",
    `- Rounds per successful task: ${formatAverage(metrics.checklist.rounds_per_successful_task)} (target < 5)`,
    `- Human interventions per task: ${formatAverage(metrics.checklist.human_interventions_per_task)} (target < 2)`,
    `- Average cost per round (USD): ${metrics.checklist.average_cost_usd_per_round === null ? "n/a" : formatUsd(metrics.checklist.average_cost_usd_per_round)}`,
    `- Evaluator infrastructure failures: ${metrics.checklist.evaluator_infrastructure_failures} (target 0)`,
    `- Hot-file growth lines: ${metrics.checklist.hot_file_growth_lines} (target 0)`,
    "Rounds per successful task:"
  ];

  const successfulTasks = metrics.tasks.filter((task) => task.successful);
  if (successfulTasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of successfulTasks) {
      lines.push(`- ${task.objective} | stable_id=${task.stable_id} | rounds=${task.rounds}`);
    }
  }

  lines.push("Cost per task (USD):");
  if (metrics.tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of metrics.tasks) {
      lines.push(
        `- ${task.objective} | stable_id=${task.stable_id} | total_usd=${formatUsd(task.total_cost_usd)} | avg_usd_per_round=${formatUsd(task.average_cost_usd_per_round)}`
      );
    }
  }

  lines.push("Human interventions per task:");
  if (metrics.tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of metrics.tasks) {
      lines.push(`- ${task.objective} | stable_id=${task.stable_id} | count=${task.human_interventions}`);
    }
  }

  lines.push("No-op claim mismatches per task:");
  if (metrics.tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of metrics.tasks) {
      lines.push(`- ${task.objective} | stable_id=${task.stable_id} | count=${task.no_op_claim_mismatches}`);
    }
  }

  lines.push("Evaluator infrastructure failure count:");
  if (metrics.tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of metrics.tasks) {
      lines.push(`- ${task.objective} | stable_id=${task.stable_id} | count=${task.evaluator_infrastructure_failures}`);
    }
  }

  lines.push("Hot-file growth totals:");
  if (metrics.tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of metrics.tasks) {
      lines.push(`- ${task.objective} | stable_id=${task.stable_id} | lines=${task.hot_file_growth_lines}`);
    }
  }

  if (baselineComparison) {
    lines.push(`Baseline comparison runs dir: ${baselineComparison.baseline_runs_dir}`);
    lines.push("Baseline checklist comparison:");
    lines.push(
      formatChecklistComparisonLine(
        "Rounds per successful task",
        baselineComparison.checklist.rounds_per_successful_task,
        formatAverage
      )
    );
    lines.push(
      formatChecklistComparisonLine(
        "Human interventions per task",
        baselineComparison.checklist.human_interventions_per_task,
        formatAverage
      )
    );
    lines.push(
      formatChecklistComparisonLine(
        "Average cost per round (USD)",
        baselineComparison.checklist.average_cost_usd_per_round,
        (value) => (value === null ? "n/a" : formatUsd(value))
      )
    );
    lines.push(
      formatChecklistComparisonLine(
        "Evaluator infrastructure failures",
        baselineComparison.checklist.evaluator_infrastructure_failures,
        formatCount
      )
    );
    lines.push(
      formatChecklistComparisonLine(
        "Hot-file growth lines",
        baselineComparison.checklist.hot_file_growth_lines,
        formatCount
      )
    );
  }

  return lines.join("\n");
}
