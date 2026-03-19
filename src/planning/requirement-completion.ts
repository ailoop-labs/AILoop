import type { EvaluationResult, ToolResult } from "../types/contracts";

const LIFECYCLE_HEADING = "## Lifecycle Status";
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "when",
  "with"
]);

export interface RequirementCompletionAssessment {
  isComplete: boolean;
  matchedCriteria: string[];
  unmatchedCriteria: string[];
  reason: string;
}

function normalizeMarkdown(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_#]/g, " ")
    .replace(/[^a-z0-9./_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const criteria: string[] = [];
  let insideSection = false;
  let currentBullet: string[] = [];

  const flushCurrentBullet = (): void => {
    if (currentBullet.length === 0) {
      return;
    }

    const normalized = currentBullet.join(" ").replace(/\s+/g, " ").trim();
    if (normalized) {
      criteria.push(normalized);
    }
    currentBullet = [];
  };

  for (const line of lines) {
    if (/^##\s+Acceptance Criteria\b/i.test(line.trim())) {
      insideSection = true;
      continue;
    }

    if (insideSection && /^##\s+/.test(line.trim())) {
      flushCurrentBullet();
      break;
    }

    if (!insideSection) {
      continue;
    }

    const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (bulletMatch) {
      flushCurrentBullet();
      currentBullet.push(bulletMatch[1] ?? "");
      continue;
    }

    if (currentBullet.length > 0 && line.trim()) {
      currentBullet.push(line.trim());
    }
  }

  flushCurrentBullet();
  return criteria;
}

function collectCriterionTokens(criterion: string): string[] {
  const normalized = normalizeForMatching(criterion);
  const fileLikeTokens = Array.from(new Set(normalized.match(/[a-z0-9._/-]+\.[a-z0-9._/-]+/g) ?? []));
  const wordTokens = normalized
    .split(" ")
    .filter((token) => token.length >= 4)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !fileLikeTokens.includes(token));

  return Array.from(new Set([...fileLikeTokens, ...wordTokens]));
}

function criterionMatchesCorpus(criterion: string, corpus: string): boolean {
  const normalizedCriterion = normalizeForMatching(criterion);
  if (!normalizedCriterion) {
    return false;
  }

  if (corpus.includes(normalizedCriterion)) {
    return true;
  }

  const tokens = collectCriterionTokens(criterion);
  if (tokens.length === 0) {
    return false;
  }

  const fileLikeTokens = tokens.filter((token) => token.includes("/") || token.includes("."));
  if (fileLikeTokens.some((token) => !corpus.includes(token))) {
    return false;
  }

  const wordTokens = tokens.filter((token) => !fileLikeTokens.includes(token));
  if (wordTokens.length === 0) {
    return true;
  }

  const matchedWords = wordTokens.filter((token) => corpus.includes(token)).length;
  const requiredMatches =
    wordTokens.length <= 2 ? wordTokens.length : Math.max(2, Math.ceil(wordTokens.length * 0.6));

  return matchedWords >= requiredMatches;
}

function buildEvidenceCorpus(input: {
  evaluation: EvaluationResult;
  toolResult: ToolResult;
  stateChange: string;
}): string {
  return normalizeForMatching(
    [
      input.evaluation.justification,
      ...input.evaluation.evidence,
      input.evaluation.recommended_next_action ?? "",
      ...(input.toolResult.operational_evidence ?? []),
      input.stateChange
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function stripLifecycleSection(markdown: string): string {
  return normalizeMarkdown(markdown).replace(
    /\n## Lifecycle Status\b[\s\S]*?(?=\n##\s+|\s*$)/,
    "\n"
  ).trimEnd();
}

export function getRequirementLifecycleStatus(markdown: string | null): "active" | "complete" {
  if (!markdown?.trim()) {
    return "active";
  }

  const normalized = normalizeMarkdown(markdown);
  const lifecycleSectionMatch = normalized.match(/\n## Lifecycle Status\b[\s\S]*?(?=\n##\s+|\s*$)/);
  if (!lifecycleSectionMatch) {
    return "active";
  }

  return /status:\s*complete/i.test(lifecycleSectionMatch[0]) ? "complete" : "active";
}

export function assessRequirementCompletion(input: {
  requirementMarkdown: string;
  evaluation: EvaluationResult;
  toolResult: ToolResult;
  stateChange: string;
}): RequirementCompletionAssessment {
  const acceptanceCriteria = extractAcceptanceCriteria(input.requirementMarkdown);
  if (input.evaluation.decision !== "pass") {
    return {
      isComplete: false,
      matchedCriteria: [],
      unmatchedCriteria: acceptanceCriteria,
      reason: "Evaluator did not pass, so the active requirement slice remains in progress."
    };
  }

  if (acceptanceCriteria.length === 0) {
    return {
      isComplete: false,
      matchedCriteria: [],
      unmatchedCriteria: [],
      reason: "No acceptance criteria were found in the active requirement artifact."
    };
  }

  const corpus = buildEvidenceCorpus(input);
  const matchedCriteria = acceptanceCriteria.filter((criterion) => criterionMatchesCorpus(criterion, corpus));
  const unmatchedCriteria = acceptanceCriteria.filter((criterion) => !matchedCriteria.includes(criterion));

  return {
    isComplete: unmatchedCriteria.length === 0,
    matchedCriteria,
    unmatchedCriteria,
    reason:
      unmatchedCriteria.length === 0
        ? "All acceptance criteria were matched against pass-round evidence."
        : "At least one acceptance criterion is still missing from pass-round evidence."
  };
}

export function upsertRequirementLifecycleStatus(
  markdown: string,
  assessment: RequirementCompletionAssessment,
  round: number
): string {
  const base = stripLifecycleSection(markdown);
  const lines = [
    LIFECYCLE_HEADING,
    `- Status: ${assessment.isComplete ? "complete" : "active"}`,
    `- Completed In Round: ${round}`,
    `- Completion Reason: ${assessment.reason}`,
    `- Matched Acceptance Criteria: ${assessment.matchedCriteria.length}`,
    `- Remaining Acceptance Criteria: ${assessment.unmatchedCriteria.length}`
  ];

  if (assessment.matchedCriteria.length > 0) {
    lines.push("- Matched Criteria:");
    for (const criterion of assessment.matchedCriteria) {
      lines.push(`  - ${criterion}`);
    }
  }

  if (assessment.unmatchedCriteria.length > 0) {
    lines.push("- Remaining Criteria:");
    for (const criterion of assessment.unmatchedCriteria) {
      lines.push(`  - ${criterion}`);
    }
  }

  return normalizeMarkdown(`${base}\n\n${lines.join("\n")}`);
}
