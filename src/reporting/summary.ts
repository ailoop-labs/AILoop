import fs from "node:fs/promises";
import path from "node:path";
import type { ActionRecord, EvaluationResult, RoundArtifacts, SubTask, ToolResult } from "../types/contracts";
import type { RoundMetrics } from "./metrics";
import { ensureDir, readTextFile } from "../utils/fs";
import { SecretRedactor } from "../utils/redaction";

export interface SummaryInput {
  goal: string;
  subTask: SubTask;
  actions: ActionRecord[];
  toolResult: ToolResult;
  evaluation: EvaluationResult;
  metrics: RoundMetrics;
  risks: string[];
  autoReworkAttempts: string[];
  nextRecommendation: string;
  artifacts?: RoundArtifacts;
}

export interface RunRecord {
  timestamp: string;
  summaryPath: string;
  metricsPath: string;
  logPath: string;
  stateChangePath: string;
  evaluationPath?: string;
}

function redactArtifactText(content: string): string {
  return new SecretRedactor(process.env).redact(content);
}

function inferArtifactPathsFromSummaryPath(summaryPath: string): RoundArtifacts {
  if (summaryPath.endsWith(".round.summary.md")) {
    const stem = summaryPath.slice(0, -".round.summary.md".length);
    return {
      summaryPath,
      metricsPath: `${stem}.round.metrics.json`,
      logPath: `${stem}.round.log`,
      stateChangePath: `${stem}.round.state_change.txt`,
      evaluationPath: `${stem}.round.evaluation.json`
    };
  }

  if (summaryPath.endsWith(".summary.md")) {
    const stem = summaryPath.slice(0, -".summary.md".length);
    return {
      summaryPath,
      metricsPath: `${stem}.metrics.json`,
      logPath: `${stem}.log`,
      stateChangePath: `${stem}.state_change.txt`,
      evaluationPath: `${stem}.evaluation.json`
    };
  }

  return {
    summaryPath,
    metricsPath: `${summaryPath}.metrics.json`,
    logPath: `${summaryPath}.log`,
    stateChangePath: `${summaryPath}.state_change.txt`,
    evaluationPath: `${summaryPath}.evaluation.json`
  };
}

export async function writeLogFile(logPath: string, logLines: string[]): Promise<void> {
  await ensureDir(path.dirname(logPath));
  await fs.writeFile(logPath, `${redactArtifactText(logLines.join("\n"))}\n`, "utf8");
}

export async function appendLogLine(logPath: string, line: string): Promise<void> {
  await ensureDir(path.dirname(logPath));
  await fs.appendFile(logPath, `${redactArtifactText(line)}\n`, "utf8");
}

export async function writeStateChangeFile(stateChangePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(stateChangePath));
  await fs.writeFile(stateChangePath, redactArtifactText(content), "utf8");
}

export async function writeEvaluationFile(evaluationPath: string, evaluation: EvaluationResult): Promise<void> {
  await ensureDir(path.dirname(evaluationPath));
  const payload = `${JSON.stringify(evaluation, null, 2)}\n`;
  await fs.writeFile(evaluationPath, redactArtifactText(payload), "utf8");
}

export async function writeSummaryFile(summaryPath: string, input: SummaryInput): Promise<void> {
  await ensureDir(path.dirname(summaryPath));

  const toolsUsed = input.actions.map((action) => action.tool);
  const uniqueTools = Array.from(new Set(toolsUsed));
  const artifactPaths = input.artifacts ?? inferArtifactPathsFromSummaryPath(summaryPath);
  const logArtifactPath = input.toolResult.artifacts.log_path || artifactPaths.logPath;
  const stateChangeArtifactPath =
    input.toolResult.artifacts.state_change_path || artifactPaths.stateChangePath;

  const markdown = [
    "# AILoop Round Summary",
    "",
    "## Round Metadata",
    `- Round: ${input.metrics.round}`,
    `- Timestamp: ${input.metrics.run_timestamp}`,
    "",
    "## Goal Alignment",
    input.goal.trim() || "Goal was empty.",
    "",
    "## Planned Sub-task",
    `- Objective: ${input.subTask.objective}`,
    `- Expected Outcome: ${input.subTask.expected_outcome}`,
    `- Rationale: ${input.subTask.rationale}`,
    "",
    "## Actions Taken (Tools Used)",
    uniqueTools.length > 0 ? uniqueTools.map((tool) => `- ${tool}`).join("\n") : "- No tools were used.",
    "",
    "## Execution Result",
    `- Tool Status: ${input.toolResult.status}`,
    `- Work Summary: ${input.toolResult.summary}`,
    `- Error: ${input.toolResult.error?.message ?? "none"}`,
    "",
    "## Artifact References",
    `- Summary: ${artifactPaths.summaryPath}`,
    `- Metrics: ${artifactPaths.metricsPath}`,
    `- Log: ${logArtifactPath}`,
    `- State Change: ${stateChangeArtifactPath}`,
    `- Evaluation: ${artifactPaths.evaluationPath}`,
    "",
    "## Operational Evidence",
    input.toolResult.operational_evidence && input.toolResult.operational_evidence.length > 0
      ? input.toolResult.operational_evidence.map((item) => `- ${item}`).join("\n")
      : "- None recorded.",
    "",
    "## Evaluation Result",
    `- Decision: ${input.evaluation.decision}`,
    `- Justification: ${input.evaluation.justification}`,
    `- Root Cause: ${input.evaluation.root_cause || "none"}`,
    `- Evidence: ${input.evaluation.evidence.join(" | ") || "none"}`,
    "",
    "## Auto Rework Attempts",
    input.autoReworkAttempts.length > 0
      ? input.autoReworkAttempts.map((attempt) => `- ${attempt}`).join("\n")
      : "- No auto rework attempts were executed.",
    "",
    "## Budget Consumed vs Limit",
    `- Cost USD: ${input.metrics.budget_usage.usdUsed} / ${input.metrics.budget_limits.usdPerRound}`,
    `- Time ms: ${input.metrics.budget_usage.elapsedMs} / ${input.metrics.budget_limits.timeMinutes * 60_000}`,
    `- Actions: ${input.metrics.budget_usage.actionsUsed} / ${input.metrics.budget_limits.actions}`,
    "",
    "## Risks / Assumptions",
    input.risks.length > 0 ? input.risks.map((risk) => `- ${risk}`).join("\n") : "- None recorded.",
    "",
    "## Next Round Recommendation",
    input.nextRecommendation
  ].join("\n");

  await fs.writeFile(summaryPath, `${redactArtifactText(markdown)}\n`, "utf8");
}

export async function listRunRecords(runsDir: string, limit = 20): Promise<RunRecord[]> {
  await ensureDir(runsDir);
  const entries = await fs.readdir(runsDir);

  const grouped = new Map<string, Partial<RunRecord>>();
  for (const entry of entries) {
    const parts = entry.split(".");
    const timestamp = parts[0];
    if (!timestamp || parts.length < 3) continue;

    const record = grouped.get(timestamp) ?? { timestamp };
    const fullPath = path.join(runsDir, entry);

    if (entry.endsWith(".round.summary.md")) record.summaryPath = fullPath;
    else if (entry.endsWith(".round.metrics.json")) record.metricsPath = fullPath;
    else if (entry.endsWith(".round.log")) record.logPath = fullPath;
    else if (entry.endsWith(".round.state_change.txt")) record.stateChangePath = fullPath;
    else if (entry.endsWith(".round.evaluation.json")) record.evaluationPath = fullPath;

    grouped.set(timestamp, record);
  }

  return Array.from(grouped.values())
    .filter((item): item is RunRecord => 
      Boolean(item.timestamp && item.summaryPath && item.metricsPath && item.logPath && item.stateChangePath)
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

export async function readLastLogTail(logPath: string, lines = 200): Promise<string[]> {
  const raw = await readTextFile(logPath, "");
  const split = raw.split(/\r?\n/).filter(Boolean);
  return split.slice(-lines);
}

export function buildRoundArtifactPaths(runsDir: string, timestamp: string): RoundArtifacts {
  return {
    logPath: path.join(runsDir, `${timestamp}.round.log`),
    summaryPath: path.join(runsDir, `${timestamp}.round.summary.md`),
    metricsPath: path.join(runsDir, `${timestamp}.round.metrics.json`),
    stateChangePath: path.join(runsDir, `${timestamp}.round.state_change.txt`),
    evaluationPath: path.join(runsDir, `${timestamp}.round.evaluation.json`)
  };
}

export async function trimOldRuns(runsDir: string, keepLimit: number): Promise<void> {
  if (keepLimit <= 0) {
    return;
  }

  const all = await listRunRecords(runsDir, Number.MAX_SAFE_INTEGER);
  const extra = all.slice(keepLimit);
  for (const item of extra) {
    await Promise.all([
      fs.rm(item.logPath, { force: true }),
      fs.rm(item.summaryPath, { force: true }),
      fs.rm(item.metricsPath, { force: true }),
      fs.rm(item.stateChangePath, { force: true }),
      item.evaluationPath ? fs.rm(item.evaluationPath, { force: true }) : Promise.resolve()
    ]);
  }
}
