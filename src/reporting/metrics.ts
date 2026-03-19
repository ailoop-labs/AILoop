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
  total_cost_usd: number;
  average_cost_usd_per_round: number;
  successful: boolean;
  latest_decision: RoundMetrics["evaluator_decision"] | "unknown";
  human_interventions: number;
  no_op_claim_mismatches: number;
  evaluator_infrastructure_failures: number;
  hot_file_growth_lines: number;
  first_run_timestamp: string;
  latest_run_timestamp: string;
}

export interface ExternalValidationChecklistMetrics {
  rounds_per_successful_task: number | null;
  human_interventions_per_task: number | null;
  average_cost_usd_per_round: number | null;
  evaluator_infrastructure_failures: number;
  hot_file_growth_lines: number;
}

export interface ExternalValidationMetricsReport {
  task_count: number;
  successful_task_count: number;
  checklist: ExternalValidationChecklistMetrics;
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

function normalizeUsd(value: unknown): number {
  return Number(normalizeCounter(value).toFixed(6));
}

function normalizeAverage(value: number): number {
  return Number(value.toFixed(6));
}

const NO_OP_CLAIM_PATTERNS: RegExp[] = [
  /\bno code change(?:s)? (?:was|were) required\b/i,
  /\bno code change(?:s)? needed\b/i,
  /\bno code change(?:s)? required\b/i,
  /\bno workspace change(?:s)? (?:was|were) required\b/i,
  /\bno workspace change(?:s)? needed\b/i,
  /\bno workspace change(?:s)? required\b/i,
  /\bno changes? (?:was|were) required\b/i,
  /\bno file edits? (?:was|were) required\b/i,
  /\bno file mutations?\b/i
];

function normalizeArtifactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summaryClaimsNoOp(summary: string): boolean {
  const normalized = normalizeArtifactText(summary);
  return normalized.length > 0 && NO_OP_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectChangedFilePaths(stateChange: string): string[] {
  return Array.from(
    new Set(
      stateChange
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("+++ "))
        .map((line) => line.slice(4).trim().replace(/^b\//, ""))
        .filter((line) => line.length > 0 && line !== "/dev/null")
    )
  );
}

function stateChangeShowsConcreteEdits(stateChange: string): boolean {
  const normalized = stateChange.trim();
  if (!normalized || normalized === "No state changes detected.") {
    return false;
  }

  if (collectChangedFilePaths(stateChange).length > 0) {
    return true;
  }

  return /(^|\n)@@ /m.test(stateChange) && /(^|\n)[+-](?![+-])/m.test(stateChange);
}

function roundHasNoOpClaimMismatch(summary: string, stateChange: string): boolean {
  return summaryClaimsNoOp(summary) && stateChangeShowsConcreteEdits(stateChange);
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
    const [metrics, evaluation, summaryText, stateChangeText] = await Promise.all([
      record.metricsPath ? readMetricsFile(record.metricsPath) : Promise.resolve(null),
      record.evaluationPath ? readJsonFile<EvaluationResult | null>(record.evaluationPath, null) : Promise.resolve(null),
      record.summaryPath ? fs.readFile(record.summaryPath, "utf8").catch(() => "") : Promise.resolve(""),
      record.stateChangePath ? fs.readFile(record.stateChangePath, "utf8").catch(() => "") : Promise.resolve("")
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
      total_cost_usd: 0,
      average_cost_usd_per_round: 0,
      successful: false,
      latest_decision: "unknown" as const,
      human_interventions: 0,
      no_op_claim_mismatches: 0,
      evaluator_infrastructure_failures: 0,
      hot_file_growth_lines: 0,
      first_run_timestamp: record.timestamp,
      latest_run_timestamp: record.timestamp
    };

    existing.rounds += 1;
    existing.total_cost_usd = normalizeUsd(existing.total_cost_usd + normalizeUsd(metrics?.budget_usage?.usdUsed));
    existing.average_cost_usd_per_round = normalizeUsd(existing.total_cost_usd / existing.rounds);
    existing.successful = existing.successful || latestDecision === "pass";
    existing.latest_decision = latestDecision;
    existing.human_interventions += normalizeCounter(metrics?.human_interventions);
    existing.no_op_claim_mismatches += roundHasNoOpClaimMismatch(summaryText, stateChangeText) ? 1 : 0;
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
  const successfulTasks = tasks.filter((task) => task.successful);
  const totalRounds = tasks.reduce((sum, task) => sum + task.rounds, 0);
  const totalSuccessfulTaskRounds = successfulTasks.reduce((sum, task) => sum + task.rounds, 0);
  const totalHumanInterventions = tasks.reduce((sum, task) => sum + task.human_interventions, 0);
  const totalCostUsd = tasks.reduce((sum, task) => sum + task.total_cost_usd, 0);
  const totalEvaluatorInfrastructureFailures = tasks.reduce(
    (sum, task) => sum + task.evaluator_infrastructure_failures,
    0
  );
  const totalHotFileGrowthLines = tasks.reduce((sum, task) => sum + task.hot_file_growth_lines, 0);

  return {
    task_count: tasks.length,
    successful_task_count: successfulTasks.length,
    checklist: {
      rounds_per_successful_task:
        successfulTasks.length > 0 ? normalizeAverage(totalSuccessfulTaskRounds / successfulTasks.length) : null,
      human_interventions_per_task: tasks.length > 0 ? normalizeAverage(totalHumanInterventions / tasks.length) : null,
      average_cost_usd_per_round: totalRounds > 0 ? normalizeUsd(totalCostUsd / totalRounds) : null,
      evaluator_infrastructure_failures: totalEvaluatorInfrastructureFailures,
      hot_file_growth_lines: totalHotFileGrowthLines
    },
    tasks
  };
}
