import fs from "node:fs/promises";
import path from "node:path";
import type { BudgetLimits, BudgetUsage } from "../types/contracts";
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

export interface RoundMetrics {
  round: number;
  run_timestamp: string;
  duration_ms: number;
  budget_limits: BudgetLimits;
  budget_usage: BudgetUsage;
  evaluator_decision: "pass" | "fail";
  tool_status: "success" | "failure";
  retries: RoundRetryCounts;
  phase_timings_ms: RoundPhaseTimings;
}

export async function writeMetricsFile(metricsPath: string, metrics: RoundMetrics): Promise<void> {
  await ensureDir(path.dirname(metricsPath));
  await fs.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

export async function readMetricsFile(metricsPath: string): Promise<RoundMetrics | null> {
  return readJsonFile<RoundMetrics | null>(metricsPath, null);
}
