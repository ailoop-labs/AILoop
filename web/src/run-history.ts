export interface RunEvaluation {
  decision: "pass" | "fail";
  justification: string;
  evidence: string[];
  recommended_next_action?: string;
}

export interface RunHistoryItem {
  timestamp: string;
  summary: string;
  metrics: Record<string, unknown> | null;
  evaluation: RunEvaluation | null;
}

export interface RoundReport {
  objective: string;
  expectedOutcome: string;
  toolStatus: string;
  workSummary: string;
  error: string;
  decision: string;
  justification: string;
  evidence: string;
  budgetCost: string;
  budgetTime: string;
  budgetActions: string;
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
    evidence: extractBulletValue(summary, "Evidence") ?? "No evaluator evidence captured",
    budgetCost: extractBulletValue(summary, "Cost USD") ?? "N/A",
    budgetTime: extractBulletValue(summary, "Time ms") ?? "N/A",
    budgetActions: extractBulletValue(summary, "Actions") ?? "N/A",
    nextRecommendation: extractMarkdownSection(summary, "Next Round Recommendation") || "No recommendation captured"
  };
}

function preferStructuredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function preferStructuredEvidence(evaluation: RunEvaluation | null, fallback: string): string {
  if (!evaluation) {
    return fallback;
  }

  const evidence = evaluation.evidence.map((item) => item.trim()).filter(Boolean);
  return evidence.length > 0 ? evidence.join(" | ") : fallback;
}

export function projectRunHistoryReport(run: RunHistoryItem): RoundReport {
  const fallback = parseRoundReport(run.summary);

  return {
    ...fallback,
    decision: preferStructuredValue(run.evaluation?.decision, fallback.decision),
    justification: preferStructuredValue(run.evaluation?.justification, fallback.justification),
    evidence: preferStructuredEvidence(run.evaluation, fallback.evidence),
    nextRecommendation: preferStructuredValue(run.evaluation?.recommended_next_action, fallback.nextRecommendation)
  };
}
