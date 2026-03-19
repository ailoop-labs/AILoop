import type {
  RoundEvaluationContext,
  ValidationArtifactManifest,
  ValidationHandoff,
  ValidationRoundInconsistencySummary,
  ValidationStateChangeSummary,
  ValidationSummary,
  ValidationTargetedExcerpt
} from "../types/contracts";
import { redactSecretLikeText } from "../utils/secret-redaction";

type ValidationHandoffInput = Pick<
  RoundEvaluationContext,
  "subTask" | "toolResult" | "stateChange" | "logLines" | "budgetLimits" | "budgetUsage"
>;

const MAX_VALIDATION_HIGHLIGHTS = 4;
const MAX_TARGETED_EXCERPTS = 6;
const MAX_EXCERPT_LENGTH = 220;
const MAX_INCONSISTENCY_DIRECT_EVIDENCE = 2;
const MAX_FILE_SCOPED_DIFF_LINES = 3;

const VALIDATION_SIGNAL_PATTERNS: RegExp[] = [
  /\btest(?:s|ed|ing)?\b/i,
  /\bassert(?:ion|ed)?\b/i,
  /\bverif(?:y|ied|ication)\b/i,
  /\bvalidat(?:e|ed|ion)\b/i,
  /\bpass(?:ed)?\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\berror\b/i,
  /\bexpected\b/i,
  /\bobserved\b/i,
  /\bhealth(?: check)?\b/i,
  /\bexit code\b/i,
  /\bok\b/i
];

const STATE_CHANGE_EVIDENCE_PATTERNS: RegExp[] = [
  /\boperational\b/i,
  /\bverification\b/i,
  /\btest(?:s|ing)?\b/i,
  /\bhealth\b/i,
  /\bvalidat(?:e|ion)\b/i
];

const STATE_CHANGE_EXCERPT_PATTERNS: RegExp[] = [
  /\bhotFilePressureCount\b/i,
  /Hot-File Pressure/i,
  /Hot-File Governance/i,
  /\bHotFileGovernancePanel\b/i,
  /governance blocks/i,
  /healthStatus/i,
  /\bat_risk\b/i,
  /\bbun test\b/i,
  /System Health/i,
  /\brenderToStaticMarkup\b/i,
  /\bexpect\s*\(/i,
  /\btoContain\s*\(/i
];

const NO_MUTATION_CLAIM_PATTERNS: RegExp[] = [
  /\bno code change(?:s)? (?:was|were) required\b/i,
  /\bno code change(?:s)? needed\b/i,
  /\bno code change(?:s)? required\b/i,
  /\bno changes? (?:was|were) required\b/i,
  /\bno file edits? (?:was|were) required\b/i,
  /\bno file mutations?\b/i
];

function hasPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function normalizePromptText(value: string): string {
  return redactSecretLikeText(value.replace(/\s+/g, " ").trim());
}

function truncatePromptText(value: string, maxLength = MAX_EXCERPT_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function scoreLogEvidence(line: string): number {
  let score = 10;

  if (/\[executor\]/i.test(line)) score += 60;
  if (/\[planner\]/i.test(line)) score -= 40;
  if (/\[evaluator\]/i.test(line)) score -= 80;
  if (/run_shell_command/i.test(line)) score += 30;
  if (/\/bin\/zsh -lc/i.test(line)) score += 20;
  if (/\bbun test\b/i.test(line)) score += 45;
  if (/\b\d+\s+pass,\s+\d+\s+fail\b/i.test(line)) score += 55;
  if (/\bhotFilePressureCount\b/i.test(line)) score += 40;
  if (/Hot-File Pressure/i.test(line)) score += 35;
  if (/governance blocks/i.test(line)) score += 30;
  if (/expected_outcome|rationale|goal|failure history/i.test(line)) score -= 25;

  return score;
}

function scoreStateChangeEvidence(line: string): number {
  let score = 0;

  if (/\bhotFilePressureCount\b/i.test(line)) score += 60;
  if (/Hot-File Pressure/i.test(line)) score += 50;
  if (/Hot-File Governance/i.test(line)) score += 50;
  if (/\bHotFileGovernancePanel\b/i.test(line)) score += 40;
  if (/governance blocks/i.test(line)) score += 45;
  if (/\bhealthStatus\b/i.test(line)) score += 25;
  if (/\bat_risk\b/i.test(line)) score += 20;
  if (/\bbun test\b/i.test(line)) score += 40;
  if (/System Health/i.test(line)) score += 25;
  if (/\brenderToStaticMarkup\b/i.test(line)) score += 35;
  if (/\bexpect\s*\(/i.test(line)) score += 55;
  if (/\btoContain\s*\(/i.test(line)) score += 45;

  return score;
}

function summarizeStateChangeForEvaluation(stateChange: string): ValidationStateChangeSummary {
  const normalized = stateChange.trim();
  if (!normalized || normalized === "No state changes detected.") {
    return {
      changed_files: [],
      added_lines: 0,
      removed_lines: 0,
      notes: ["No material state changes detected."]
    };
  }

  const changedFiles = Array.from(
    new Set(
      normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("+++ "))
        .map((line) => line.slice(4).trim())
        .filter((line) => line && line !== "/dev/null")
        .map((line) => line.replace(/^b\//, ""))
        .filter((line) => !line.startsWith(".ailoop/runs/"))
    )
  );
  const addedLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .length;
  const removedLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .length;
  const notes = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("### "))
    .slice(0, 6);

  return {
    changed_files: changedFiles.slice(0, 12),
    added_lines: addedLines,
    removed_lines: removedLines,
    notes
  };
}

function buildArtifactManifest(input: ValidationHandoffInput): ValidationArtifactManifest {
  return {
    round_log_path: input.toolResult.artifacts.log_path || "",
    state_change_path: input.toolResult.artifacts.state_change_path || "",
    bundle_path: input.toolResult.artifacts.bundle_path || ""
  };
}

function summarizeNoMutationClaim(summary: string): string | null {
  const normalized = normalizePromptText(summary);
  if (!normalized || !hasPattern(NO_MUTATION_CLAIM_PATTERNS, normalized)) {
    return null;
  }

  return normalized;
}

function collectRelevantLogLines(logLines: string[]): string[] {
  return logLines
    .map((line) => normalizePromptText(line))
    .filter(Boolean)
    .filter((line) => !/\[evaluator\]/i.test(line))
    .filter((line) => hasPattern(VALIDATION_SIGNAL_PATTERNS, line))
    .map((line, index) => ({ line, index, score: scoreLogEvidence(line) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.line);
}

function collectRelevantStateChangeNotes(notes: string[]): string[] {
  return notes
    .map((note) => normalizePromptText(note))
    .filter(Boolean)
    .filter((note) => hasPattern(STATE_CHANGE_EVIDENCE_PATTERNS, note));
}

function collectRelevantStateChangeExcerpts(stateChange: string): string[] {
  return stateChange
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => normalizePromptText(line))
    .filter(Boolean)
    .filter((line) => hasPattern(STATE_CHANGE_EXCERPT_PATTERNS, line))
    .map((line, index) => ({ line, index, score: scoreStateChangeEvidence(line) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.line);
}

function collectFileScopedStateChangeExcerpts(
  stateChange: string,
  changedFiles: string[]
): Array<{ file_path: string; excerpt: string }> {
  if (changedFiles.length === 0) {
    return [];
  }

  const requestedFiles = new Set(changedFiles);
  const results: Array<{ file_path: string; excerpt: string }> = [];
  const lines = stateChange.split("\n");

  for (let index = 0; index < lines.length && results.length < MAX_INCONSISTENCY_DIRECT_EVIDENCE; index += 1) {
    const line = lines[index]?.trimEnd() ?? "";
    if (!line.startsWith("+++ ")) {
      continue;
    }

    const filePath = line.slice(4).trim().replace(/^b\//, "");
    if (!requestedFiles.has(filePath) || filePath.startsWith(".ailoop/runs/")) {
      continue;
    }

    const excerptLines: string[] = [];
    for (let innerIndex = index + 1; innerIndex < lines.length; innerIndex += 1) {
      const nextLine = lines[innerIndex]?.trimEnd() ?? "";
      if (nextLine.startsWith("### ") || nextLine.startsWith("+++ ")) {
        break;
      }

      const normalized = normalizePromptText(nextLine);
      if (!normalized) {
        continue;
      }

      if (nextLine.startsWith("@@")) {
        excerptLines.push(normalized);
        continue;
      }

      if (
        (nextLine.startsWith("+") || nextLine.startsWith("-")) &&
        !nextLine.startsWith("+++") &&
        !nextLine.startsWith("---")
      ) {
        excerptLines.push(normalized);
      }

      if (excerptLines.length >= MAX_FILE_SCOPED_DIFF_LINES + 1) {
        break;
      }
    }

    if (excerptLines.length === 0) {
      continue;
    }

    results.push({
      file_path: filePath,
      excerpt: [filePath, ...excerptLines].join(" | ")
    });
    requestedFiles.delete(filePath);
  }

  return results;
}

function buildRoundInconsistencySummary(
  input: ValidationHandoffInput,
  stateChangeSummary: ValidationStateChangeSummary,
  artifactManifest: ValidationArtifactManifest
): ValidationRoundInconsistencySummary {
  const noMutationClaim = summarizeNoMutationClaim(input.toolResult.summary);
  if (!noMutationClaim || stateChangeSummary.changed_files.length === 0) {
    return {
      status: "none",
      summary: "No round-level inconsistency detected between executor summary and recorded state-change artifact.",
      conflicting_signals: [],
      direct_evidence: []
    };
  }

  const directEvidence = collectFileScopedStateChangeExcerpts(input.stateChange, stateChangeSummary.changed_files).map(
    (item) => ({
      ...item,
      artifact_path: artifactManifest.state_change_path || ""
    })
  );
  const changedFilesLabel = stateChangeSummary.changed_files.join(", ");

  return {
    status: "present",
    summary:
      `Executor summary claims no code change, but the state-change artifact records edits in ` +
      `${stateChangeSummary.changed_files.length} file(s): ${changedFilesLabel}.`,
    conflicting_signals: [
      `executor_summary: ${noMutationClaim}`,
      `state_change_summary: changed_files=${JSON.stringify(stateChangeSummary.changed_files)}, added_lines=${stateChangeSummary.added_lines}, removed_lines=${stateChangeSummary.removed_lines}`
    ],
    direct_evidence: directEvidence
  };
}

function buildValidationSummary(
  input: ValidationHandoffInput,
  stateChangeSummary: ValidationStateChangeSummary,
  artifactManifest: ValidationArtifactManifest
): ValidationSummary {
  const operationalEvidence = (input.toolResult.operational_evidence ?? [])
    .map((line) => normalizePromptText(line))
    .filter(Boolean);
  const logSignals = collectRelevantLogLines(input.logLines);
  const stateChangeSignals = [
    ...collectRelevantStateChangeExcerpts(input.stateChange),
    ...collectRelevantStateChangeNotes(stateChangeSummary.notes)
  ];
  const errorSignal = input.toolResult.error
    ? normalizePromptText(`${input.toolResult.error.type}: ${input.toolResult.error.message}`)
    : "";

  if (operationalEvidence.length > 0) {
    return {
      status: "recorded",
      summary: `Executor recorded ${operationalEvidence.length} concise validation signal(s); rely on these before opening full artifacts.`,
      primary_sources: ["tool_result.operational_evidence"],
      highlighted_signals: operationalEvidence.slice(0, MAX_VALIDATION_HIGHLIGHTS),
      full_detail_artifacts: [artifactManifest.state_change_path, artifactManifest.round_log_path].filter(Boolean)
    };
  }

  if (errorSignal) {
    return {
      status: "error_only",
      summary: "Executor reported a concrete error but did not attach separate validation evidence.",
      primary_sources: ["tool_result.error", "artifact_manifest.round_log_path"],
      highlighted_signals: [errorSignal],
      full_detail_artifacts: [artifactManifest.round_log_path].filter(Boolean)
    };
  }

  if (logSignals.length > 0 || stateChangeSignals.length > 0) {
    return {
      status: "derived",
      summary: "No explicit validation summary was attached; use the smallest executor-log and state-change excerpts selected as direct evidence.",
      primary_sources: [
        ...(logSignals.length > 0 ? ["artifact_manifest.round_log_path"] : []),
        ...(stateChangeSignals.length > 0 ? ["artifact_manifest.state_change_path"] : [])
      ],
      highlighted_signals: [...stateChangeSignals, ...logSignals].slice(0, MAX_VALIDATION_HIGHLIGHTS),
      full_detail_artifacts: [artifactManifest.round_log_path, artifactManifest.state_change_path].filter(Boolean)
    };
  }

  return {
    status: "missing",
    summary: "No explicit validation evidence was recorded; judge from executor summary, artifact references, and compact state-change summary only.",
    primary_sources: ["executor_summary", "artifact_manifest"],
    highlighted_signals: [],
    full_detail_artifacts: [artifactManifest.round_log_path, artifactManifest.state_change_path].filter(Boolean)
  };
}

function buildTargetedExcerpts(
  input: ValidationHandoffInput,
  stateChangeSummary: ValidationStateChangeSummary,
  artifactManifest: ValidationArtifactManifest,
  roundInconsistencySummary: ValidationRoundInconsistencySummary
): ValidationTargetedExcerpt[] {
  const targeted: ValidationTargetedExcerpt[] = [];
  const seen = new Set<string>();

  const addExcerpt = (candidate: ValidationTargetedExcerpt): void => {
    if (targeted.length >= MAX_TARGETED_EXCERPTS) {
      return;
    }

    const excerpt = truncatePromptText(normalizePromptText(candidate.excerpt));
    if (!excerpt || seen.has(`${candidate.source}:${excerpt}`)) {
      return;
    }

    seen.add(`${candidate.source}:${excerpt}`);
    targeted.push({
      ...candidate,
      excerpt
    });
  };

  for (const evidence of roundInconsistencySummary.direct_evidence) {
    addExcerpt({
      source: "round_inconsistency_summary.direct_evidence",
      artifact_path: evidence.artifact_path,
      selection_reason:
        "Executor summary and state-change artifact conflict; include the file-scoped diff excerpt that makes the mismatch concrete.",
      excerpt: evidence.excerpt
    });
  }

  for (const line of input.toolResult.operational_evidence ?? []) {
    addExcerpt({
      source: "tool_result.operational_evidence",
      artifact_path: artifactManifest.state_change_path || artifactManifest.round_log_path || "",
      selection_reason:
        "Executor marked this as operational/validation evidence; include the shortest direct verification claim instead of the full artifact body.",
      excerpt: line
    });
  }

  if (input.toolResult.error) {
    addExcerpt({
      source: "tool_result.error",
      artifact_path: artifactManifest.round_log_path || "",
      selection_reason:
        "Executor reported a concrete failure signal; include the error itself without embedding the full round log.",
      excerpt: `${input.toolResult.error.type}: ${input.toolResult.error.message}`
    });
  }

  for (const excerpt of collectRelevantStateChangeExcerpts(input.stateChange)) {
    addExcerpt({
      source: "state_change_excerpt",
      artifact_path: artifactManifest.state_change_path || "",
      selection_reason:
        "This compact state-change excerpt shows the observable implementation surface without embedding the full diff.",
      excerpt
    });
  }

  for (const note of collectRelevantStateChangeNotes(stateChangeSummary.notes)) {
    addExcerpt({
      source: "state_change_summary.notes",
      artifact_path: artifactManifest.state_change_path || "",
      selection_reason:
        "State-change notes identify where verification or operational follow-up was recorded; include the note instead of the raw diff.",
      excerpt: note
    });
  }

  for (const line of collectRelevantLogLines(input.logLines)) {
    addExcerpt({
      source: "log_lines",
      artifact_path: artifactManifest.round_log_path || "",
      selection_reason:
        "This executor log line is a direct verification or implementation signal and is more probative than planner/process guidance.",
      excerpt: line
    });
  }

  return targeted;
}

export function buildValidationHandoff(input: ValidationHandoffInput): ValidationHandoff {
  const artifactManifest = buildArtifactManifest(input);
  const stateChangeSummary = summarizeStateChangeForEvaluation(input.stateChange);
  const roundInconsistencySummary = buildRoundInconsistencySummary(input, stateChangeSummary, artifactManifest);

  return {
    objective: input.subTask.objective,
    expected_outcome: input.subTask.expected_outcome,
    executor_summary: {
      status: input.toolResult.status,
      summary: redactSecretLikeText(input.toolResult.summary),
      next_state_hint: input.toolResult.next_state_hint ?? "continue",
      error: input.toolResult.error
        ? {
            type: redactSecretLikeText(input.toolResult.error.type),
            message: redactSecretLikeText(input.toolResult.error.message)
          }
        : null
    },
    validation_summary: buildValidationSummary(input, stateChangeSummary, artifactManifest),
    artifact_manifest: artifactManifest,
    budget_limits: input.budgetLimits,
    budget_usage: input.budgetUsage,
    state_change_summary: stateChangeSummary,
    round_inconsistency_summary: roundInconsistencySummary,
    targeted_excerpts: buildTargetedExcerpts(input, stateChangeSummary, artifactManifest, roundInconsistencySummary)
  };
}
