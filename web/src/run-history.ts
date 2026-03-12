export interface RunEvaluation {
  decision: "pass" | "fail";
  justification: string;
  root_cause?: string;
  evidence: string[];
  aggregate_score?: number;
  dimensions?: RunEvaluationDimension[];
  recommended_next_action?: string;
}

export interface RunEvaluationDimension {
  dimension: string;
  decision: "pass" | "fail" | "unknown";
  score?: number;
  confidence?: number;
  justification: string;
  evidence: string[];
  blocking_issues: string[];
  recommended_next_action?: string;
}

export interface ExpertOpinion {
  expert_role: string;
  vote: "approve" | "reject";
  rationale: string;
  incapacity_flag: boolean;
}

export interface GovernanceDetails {
  leader: {
    rationale: string;
    action: string;
    diagnosis_type: string;
    instructions: string[];
  } | null;
  ccb: {
    proposed_change: string;
    final_decision: string;
    experts: ExpertOpinion[];
  } | null;
}

export interface RunHistoryItem {
  timestamp: string;
  round?: number;
  summary: string;
  metrics: Record<string, unknown> | null;
  evaluation: RunEvaluation | null;
  has_governance?: boolean;
}

export interface RoundReportDimension {
  label: string;
  decision: "pass" | "fail" | "unknown";
  score: string;
  confidence: string;
  justification: string;
  evidence: string;
  blockingIssues: string;
  nextRecommendation: string;
}

export interface RoundReport {
  objective: string;
  expectedOutcome: string;
  toolStatus: string;
  workSummary: string;
  error: string;
  decision: string;
  justification: string;
  rootCause: string;
  evidence: string;
  aggregateScore: string;
  budgetCost: string;
  budgetTime: string;
  budgetActions: string;
  dimensionBreakdown: RoundReportDimension[];
  nextRecommendation: string;
}

function extractBulletValue(summary: string, label: string): string | null {
  const prefix = `- ${label}:`;
  const line = summary
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!line) {
    return null;
  }
  return line.slice(prefix.length).trim();
}

function extractMarkdownSection(summary: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = summary.indexOf(marker);
  if (start === -1) {
    return "";
  }

  const rest = summary.slice(start + marker.length).replace(/^\s*\n/, "");
  const nextHeadingIndex = rest.search(/\n##\s+/);
  return (nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex)).trim();
}

function parseRoundReport(summary: string): RoundReport {
  return {
    objective: extractBulletValue(summary, "Objective") ?? "No objective captured",
    expectedOutcome: extractBulletValue(summary, "Expected Outcome") ?? "No expected outcome captured",
    toolStatus: extractBulletValue(summary, "Tool Status") ?? "unknown",
    workSummary: extractBulletValue(summary, "Work Summary") ?? "No work summary captured",
    error: extractBulletValue(summary, "Error") ?? "none",
    decision: extractBulletValue(summary, "Decision") ?? "unknown",
    justification: extractBulletValue(summary, "Justification") ?? "No evaluator justification captured",
    rootCause: extractBulletValue(summary, "Root Cause") ?? "none",
    evidence: extractBulletValue(summary, "Evidence") ?? "No evaluator evidence captured",
    budgetCost: extractBulletValue(summary, "Cost USD") ?? "N/A",
    budgetTime: extractBulletValue(summary, "Time ms") ?? "N/A",
    budgetActions: extractBulletValue(summary, "Actions") ?? "N/A",
    aggregateScore: "N/A",
    dimensionBreakdown: [],
    nextRecommendation: extractMarkdownSection(summary, "Next Round Recommendation") || "No recommendation captured"
  };
}

function preferStructuredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function preferStructuredEvidence(evaluation: RunEvaluation | null, fallback: string): string {
  if (!evaluation || !evaluation.evidence || !Array.isArray(evaluation.evidence)) {
    return fallback;
  }

  const evidence = evaluation.evidence.map((item) => item.trim()).filter(Boolean);
  return evidence.length > 0 ? evidence.join(" | ") : fallback;
}

function preferStructuredAggregateScore(evaluation: RunEvaluation | null): string {
  if (typeof evaluation?.aggregate_score !== "number" || !Number.isFinite(evaluation.aggregate_score)) {
    return "N/A";
  }

  return `${evaluation.aggregate_score}`;
}

function formatDimensionLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatStructuredNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}` : "N/A";
}

function joinStructuredItems(items: string[] | undefined | null, emptyValue: string): string {
  if (!items || !Array.isArray(items)) {
    return emptyValue;
  }
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized.join(" | ") : emptyValue;
}

function preferStructuredDimensionBreakdown(evaluation: RunEvaluation | null): RoundReportDimension[] {
  if (!evaluation?.dimensions || !Array.isArray(evaluation.dimensions)) {
    return [];
  }

  return evaluation.dimensions.map((dimension) => ({
    label: formatDimensionLabel(dimension.dimension),
    decision: dimension.decision,
    score: formatStructuredNumber(dimension.score),
    confidence: formatStructuredNumber(dimension.confidence),
    justification: (dimension.justification || "").trim() || "No justification provided",
    evidence: joinStructuredItems(dimension.evidence, "No evaluator evidence captured"),
    blockingIssues: joinStructuredItems(dimension.blocking_issues, "None"),
    nextRecommendation: dimension.recommended_next_action?.trim() || "No recommendation captured"
  }));
}

export function projectRunHistoryReport(run: RunHistoryItem): RoundReport {
  const fallback = parseRoundReport(run.summary);

  return {
    ...fallback,
    decision: preferStructuredValue(run.evaluation?.decision, fallback.decision),
    justification: preferStructuredValue(run.evaluation?.justification, fallback.justification),
    rootCause: preferStructuredValue(run.evaluation?.root_cause, fallback.rootCause),
    evidence: preferStructuredEvidence(run.evaluation, fallback.evidence),
    aggregateScore: preferStructuredAggregateScore(run.evaluation),
    dimensionBreakdown: preferStructuredDimensionBreakdown(run.evaluation),
    nextRecommendation: preferStructuredValue(run.evaluation?.recommended_next_action, fallback.nextRecommendation)
  };
}
