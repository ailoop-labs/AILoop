import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BudgetLimits, BudgetUsage, SubTask } from "../types/contracts";
import { ensureDir, readJsonFile } from "../utils/fs";

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
