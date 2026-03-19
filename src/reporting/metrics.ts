import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BudgetLimits, BudgetUsage, EvaluationResult, SubTask } from "../types/contracts";
import { ensureDir, readJsonFile } from "../utils/fs";
import { listRunRecords } from "./summary";

export interface RoundRetryCounts {
  evidence_remediation_attempts: number;
  auto_rework_attempts: number;
  auto_rework_limit: number;
}

export interface RoundPhaseTimings {
  planning: number;
  execution: number;
  evaluation: number;
  operational_followup: number;
}

export type RoundFailureMode = "timeout" | "planning_failure" | "execution_failure";

export interface RoundSubTaskIdentity {
  stable_id: string;
  assignee: SubTask["assignee"];
  objective: string;
  expected_outcome: string;
}

export interface RoundMetrics {
  round: number;
  run_timestamp: string;
  duration_ms: number;
  budget_limits: BudgetLimits;
  budget_usage: BudgetUsage;
  evaluator_decision: "pass" | "fail";
  tool_status: "success" | "failure";
  failure_mode?: RoundFailureMode;
  retries: RoundRetryCounts;
  phase_timings_ms: RoundPhaseTimings;
  human_interventions: number;
  hot_file_growth_lines: number;
  sub_task_identity?: RoundSubTaskIdentity;
}

export interface ExternalValidationTaskMetrics {
  stable_id: string;
  assignee: SubTask["assignee"];
  objective: string;
  expected_outcome: string;
  rounds: number;
  successful: boolean;
  latest_decision: RoundMetrics["evaluator_decision"] | "unknown";
  human_interventions: number;
  evaluator_infrastructure_failures: number;
  hot_file_growth_lines: number;
  first_run_timestamp: string;
  latest_run_timestamp: string;
}

export interface ExternalValidationMetricsReport {
  task_count: number;
  successful_task_count: number;
  tasks: ExternalValidationTaskMetrics[];
}

function normalizeSubTaskIdentityText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildRoundSubTaskIdentity(subTask: SubTask): RoundSubTaskIdentity {
  const assignee = subTask.assignee;
  const objective = normalizeSubTaskIdentityText(subTask.objective);
  const expectedOutcome = normalizeSubTaskIdentityText(subTask.expected_outcome);
  const stableId = createHash("sha256")
    .update(JSON.stringify({ assignee, objective, expected_outcome: expectedOutcome }))
    .digest("hex");

  return {
    stable_id: stableId,
    assignee,
    objective,
    expected_outcome: expectedOutcome
  };
}

export async function writeMetricsFile(metricsPath: string, metrics: RoundMetrics): Promise<void> {
  await ensureDir(path.dirname(metricsPath));
  await fs.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

export async function readMetricsFile(metricsPath: string): Promise<RoundMetrics | null> {
  return readJsonFile<RoundMetrics | null>(metricsPath, null);
}

function normalizeCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isEvaluatorInfrastructureFailure(evaluation: EvaluationResult | null): boolean {
  if (!evaluation) {
    return false;
  }

  if (typeof evaluation.root_cause === "string" && evaluation.root_cause.startsWith("evaluator_infrastructure:")) {
    return true;
  }

  return /^Evaluator infrastructure failure:/i.test(evaluation.justification);
}

export async function buildExternalValidationMetricsReport(runsDir: string): Promise<ExternalValidationMetricsReport> {
  const records = await listRunRecords(runsDir, Number.MAX_SAFE_INTEGER);
  const tasksByStableId = new Map<string, ExternalValidationTaskMetrics>();

  for (const record of records.sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    const [metrics, evaluation] = await Promise.all([
      record.metricsPath ? readMetricsFile(record.metricsPath) : Promise.resolve(null),
      record.evaluationPath ? readJsonFile<EvaluationResult | null>(record.evaluationPath, null) : Promise.resolve(null)
    ]);
    const identity = metrics?.sub_task_identity;

    if (!identity?.stable_id) {
      continue;
    }

    const latestDecision = evaluation?.decision ?? metrics.evaluator_decision ?? "unknown";
    const existing = tasksByStableId.get(identity.stable_id) ?? {
      stable_id: identity.stable_id,
      assignee: identity.assignee,
      objective: identity.objective,
      expected_outcome: identity.expected_outcome,
      rounds: 0,
      successful: false,
      latest_decision: "unknown" as const,
      human_interventions: 0,
      evaluator_infrastructure_failures: 0,
      hot_file_growth_lines: 0,
      first_run_timestamp: record.timestamp,
      latest_run_timestamp: record.timestamp
    };

    existing.rounds += 1;
    existing.successful = existing.successful || latestDecision === "pass";
    existing.latest_decision = latestDecision;
    existing.human_interventions += normalizeCounter(metrics?.human_interventions);
    existing.hot_file_growth_lines += normalizeCounter(metrics?.hot_file_growth_lines);
    existing.evaluator_infrastructure_failures += isEvaluatorInfrastructureFailure(evaluation) ? 1 : 0;
    existing.first_run_timestamp =
      record.timestamp.localeCompare(existing.first_run_timestamp) < 0 ? record.timestamp : existing.first_run_timestamp;
    existing.latest_run_timestamp =
      record.timestamp.localeCompare(existing.latest_run_timestamp) > 0 ? record.timestamp : existing.latest_run_timestamp;

    tasksByStableId.set(identity.stable_id, existing);
  }

  const tasks = Array.from(tasksByStableId.values()).sort((left, right) =>
    left.first_run_timestamp.localeCompare(right.first_run_timestamp)
  );

  return {
    task_count: tasks.length,
    successful_task_count: tasks.filter((task) => task.successful).length,
    tasks
  };
}
