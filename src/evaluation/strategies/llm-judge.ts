import type { AppConfig } from "../../config/env";
import type {
  DimensionAssessment,
  EvaluationDimension,
  EvaluationRecoveryPath,
  EvaluationResult,
  HotFileGovernanceResult,
  RoundEvaluationContext,
  ValidationRoundInconsistencySummary
} from "../../types/contracts";
import { AIClient, type JsonSchema } from "../../agent/ai-client";
import { loadProjectRoleDefinition } from "../../agent/role-definitions";
import { buildInternalRuntimeSessionGuide } from "../../agent/runtime-policy";
import { redactSecretLikeText } from "../../utils/secret-redaction";
import type { Evaluator } from "../evaluator";

const DIMENSION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    dimension: {
      type: "string",
      enum: [
        "goal_alignment",
        "causal_validity",
        "constraint_compliance",
        "risk_externality",
        "reversibility_resilience",
        "learning_yield"
      ]
    },
    decision: { type: "string", enum: ["pass", "fail", "unknown"] },
    score: { type: "number" },
    confidence: { type: "number" },
    justification: { type: "string" },
    evidence: {
      type: "array",
      items: { type: "string" }
    },
    blocking_issues: {
      type: "array",
      items: { type: "string" }
    },
    recommended_next_action: { type: "string" }
  },
  required: [
    "dimension",
    "decision",
    "score",
    "confidence",
    "justification",
    "evidence",
    "blocking_issues",
    "recommended_next_action"
  ],
  additionalProperties: false
};

const DIMENSION_WEIGHTS: Record<EvaluationDimension, number> = {
  goal_alignment: 0.25,
  causal_validity: 0.2,
  constraint_compliance: 0.2,
  risk_externality: 0.15,
  reversibility_resilience: 0.1,
  learning_yield: 0.1
};

const HARD_GATE_DIMENSIONS = new Set<EvaluationDimension>(["constraint_compliance", "risk_externality"]);
const KEY_DIMENSIONS = new Set<EvaluationDimension>(["goal_alignment", "causal_validity", "constraint_compliance"]);

const DIMENSION_GUIDANCE: Record<EvaluationDimension, string[]> = {
  goal_alignment: [
    "Verify measurable progress toward the stated objective.",
    "Fail if actions are mostly cosmetic or unrelated to expected_outcome."
  ],
  causal_validity: [
    "Verify claimed outcomes are causally supported by round actions and evidence.",
    "Return unknown when evidence cannot establish causality."
  ],
  constraint_compliance: [
    "Verify budget/safety/policy constraints are respected.",
    "Fail on any concrete policy or hard-budget violation.",
    "Do not fail solely because changed files extend beyond the stated objective; treat file-range expansion as a weak signal unless paired with concrete constraint evidence."
  ],
  risk_externality: [
    "Assess newly introduced risks and negative side effects.",
    "Fail when severe unresolved risk is introduced.",
    "Prioritize semantic behavior impact, blast radius, and missing verification evidence over raw changed-file count."
  ],
  reversibility_resilience: [
    "Assess rollback ability and whether resilience degraded.",
    "Fail when changes are brittle or difficult to recover."
  ],
  learning_yield: [
    "Assess whether this round created reusable learning for later rounds.",
    "Unknown is acceptable if evidence is insufficient."
  ]
};

const DIMENSION_DECISION_EXAMPLES: Partial<Record<EvaluationDimension, string[]>> = {
  constraint_compliance: [
    "scope-only signal (pass): changed files exceed objective scope but no concrete policy, budget, or safety violation evidence.",
    "concrete violation (fail): clear policy/budget/safety breach exists (for example secret leakage, forbidden command, hard-budget breach)."
  ],
  risk_externality: [
    "scope-only signal (pass or unknown): extra touched files are observed but no severe behavior regression or unresolved safety risk is evidenced.",
    "concrete risk (fail): evidence shows severe unresolved side effects (for example data loss risk, irreversible mutation, production instability)."
  ]
};

const EVIDENCE_PRIORITY_LINES: string[] = [
  "behavioral verification evidence (tests/commands/runtime checks) >",
  "explicit policy/budget/safety evidence (guardrail breach, secret leak, forbidden action) >",
  "structural scope signal evidence (file count/path spread, out-of-scope file touches)"
];

const HOT_FILE_RESULT_CLASS = "hot_file_growth_failure" as const;

const HOT_FILE_CONTEXT_PATTERNS: RegExp[] = [
  /hot[- ]file/i,
  /pressured (?:workspace )?file/i,
  /pressured-file/i,
  /recent-touch hot-file pressure/i,
  /line-count pressure/i,
  /recent-touch pressure/i,
  /repeated modification/i,
  /repeatedly modified/i,
  /modification pressure/i
];

const HOT_FILE_FAILURE_PATTERNS: RegExp[] = [
  /continued growth/i,
  /unnecessary growth/i,
  /growth failure/i,
  /without bounded justification/i,
  /without bounded structural(?:-|\s)maintenance/i,
  /structural(?:-|\s)governance blockage/i,
  /structural(?:-|\s)maintenance round/i
];

const HOT_FILE_LABEL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "warning", pattern: /\bwarning\b/i },
  { label: "refactor candidate", pattern: /refactor candidate/i },
  { label: "recent-touch hot-file pressure", pattern: /recent-touch hot-file pressure/i },
  { label: "line-count pressure", pattern: /line-count pressure/i },
  { label: "recent-touch pressure", pattern: /recent-touch pressure/i },
  { label: "repeated modification pressure", pattern: /repeated modification pressure/i }
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHotFileValue(value: string): string {
  return redactSecretLikeText(
    value
      .split(/\r?\n/)
      .map((line) => line.replace(/[^\S\r\n]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  );
}

function sanitizeDimensionAssessment(
  requestedDimension: EvaluationDimension,
  candidate: Partial<DimensionAssessment> | undefined
): DimensionAssessment {
  const decision = candidate?.decision === "pass" || candidate?.decision === "fail" || candidate?.decision === "unknown"
    ? candidate.decision
    : "unknown";
  const score = typeof candidate?.score === "number" ? clamp(candidate.score, 0, 100) : 0;
  const confidence = typeof candidate?.confidence === "number" ? clamp(candidate.confidence, 0, 1) : 0;
  const justification = typeof candidate?.justification === "string" ? redactSecretLikeText(candidate.justification.trim()) : "";
  const evidence = Array.isArray(candidate?.evidence)
    ? candidate.evidence.map((item) => redactSecretLikeText(String(item).trim())).filter(Boolean)
    : [];
  const blockingIssues = Array.isArray(candidate?.blocking_issues)
    ? candidate.blocking_issues.map((item) => redactSecretLikeText(String(item).trim())).filter(Boolean)
    : [];
  const recommendedNextAction =
    typeof candidate?.recommended_next_action === "string" && candidate.recommended_next_action.trim()
      ? redactSecretLikeText(candidate.recommended_next_action.trim())
      : decision === "pass"
        ? "continue"
        : "pause and gather additional evidence";

  return {
    dimension: requestedDimension,
    decision,
    score,
    confidence,
    justification: justification || "No justification provided",
    evidence,
    blocking_issues: blockingIssues,
    recommended_next_action: recommendedNextAction
  };
}

function toEvidenceLines(assessments: DimensionAssessment[]): string[] {
  return assessments.map(
    (assessment) =>
      `${assessment.dimension}: ${assessment.decision}; score=${assessment.score.toFixed(1)}; confidence=${assessment.confidence.toFixed(2)}`
  );
}

function toDetailedEvidenceLines(assessments: DimensionAssessment[]): string[] {
  return assessments.map((assessment) => {
    const details = [assessment.justification, ...assessment.evidence, ...assessment.blocking_issues]
      .map((item) => item.trim())
      .filter(Boolean);

    return `${assessment.dimension} detail: ${details.join(" | ") || "No concrete evidence provided."}`;
  });
}

function toFollowUpActions(assessments: DimensionAssessment[]): string {
  const actions = assessments
    .map((assessment) => {
      const recommendedAction = assessment.recommended_next_action.trim();
      const action = recommendedAction && (assessment.decision === "pass" || recommendedAction !== "continue")
        ? recommendedAction
        : assessment.blocking_issues[0] ?? assessment.justification;

      return action ? `${assessment.dimension}: ${action}` : "";
    })
    .filter(Boolean);

  return actions.join("; ");
}

function withDetailedEvidence(baseEvidence: string[], assessments: DimensionAssessment[]): string[] {
  if (assessments.length === 0) {
    return baseEvidence;
  }

  return [...baseEvidence, ...toDetailedEvidenceLines(assessments)];
}

function choosePriorityAction(assessments: DimensionAssessment[]): string {
  const withBlocking = assessments.find((assessment) => assessment.blocking_issues.length > 0);
  if (withBlocking) {
    return withBlocking.blocking_issues[0] ?? withBlocking.recommended_next_action;
  }

  const failing = assessments.find((assessment) => assessment.decision === "fail");
  if (failing) {
    return failing.recommended_next_action;
  }

  const unknown = assessments.find((assessment) => assessment.decision === "unknown");
  if (unknown) {
    return `pause and gather evidence: ${unknown.recommended_next_action}`;
  }

  return "continue";
}

function extractFilePath(text: string): string | null {
  const backtickMatch = text.match(/`([^`\n]+)`/);
  if (backtickMatch?.[1]) {
    const candidate = backtickMatch[1].trim();
    if (candidate && !candidate.startsWith(".ailoop/runs/")) {
      return candidate;
    }
  }

  const inlineMatch = text.match(/\b(?:\.\/)?(?:src|web\/src|scripts|docs|tests)\/[A-Za-z0-9._/-]+\b/);
  if (inlineMatch?.[0] && !inlineMatch[0].startsWith(".ailoop/runs/")) {
    return inlineMatch[0];
  }

  return null;
}

function extractHotFileLabels(text: string): string[] {
  const labels = new Set<string>();

  const explicitMatches = [
    ...text.matchAll(/(?:heuristic|pressure) labels?:\s*([^\n.]+)/gi),
    ...text.matchAll(/labels?:\s*\[([^\]]+)\]/gi)
  ];
  for (const match of explicitMatches) {
    const raw = match[1] ?? "";
    for (const label of raw.split(/[|,]/)) {
      const normalized = normalizeHotFileValue(label).replace(/^and\s+/i, "");
      if (normalized) {
        labels.add(normalized);
      }
    }
  }

  for (const candidate of HOT_FILE_LABEL_PATTERNS) {
    if (candidate.pattern.test(text)) {
      labels.add(candidate.label);
    }
  }

  return Array.from(labels);
}

function looksLikeHotFileGovernanceText(text: string): boolean {
  return hasPattern(HOT_FILE_CONTEXT_PATTERNS, text) && hasPattern(HOT_FILE_FAILURE_PATTERNS, text);
}

function buildHotFileReason(text: string): string {
  const matchedLine = text
    .split(/\n+/)
    .map((line) => normalizeHotFileValue(line))
    .find((line) => looksLikeHotFileGovernanceText(line));

  if (matchedLine) {
    return matchedLine;
  }

  return "continued growth in pressured file without bounded justification";
}

function detectHotFileGovernance(
  assessments: DimensionAssessment[],
  aggregate: Pick<EvaluationResult, "decision" | "justification" | "recommended_next_action" | "root_cause">
): HotFileGovernanceResult | undefined {
  if (aggregate.decision !== "fail") {
    return undefined;
  }

  const sources = assessments.flatMap((assessment) => {
    const parts = [
      assessment.justification,
      ...assessment.evidence,
      ...assessment.blocking_issues,
      assessment.recommended_next_action
    ].filter(Boolean);
    const text = normalizeHotFileValue(parts.join("\n"));
    return text ? [{ assessment, text }] : [];
  });

  const aggregateText = normalizeHotFileValue(
    [aggregate.root_cause, aggregate.justification, aggregate.recommended_next_action].filter(Boolean).join("\n")
  );
  const matchingSource = sources.find((source) => looksLikeHotFileGovernanceText(source.text));

  if (!matchingSource && !looksLikeHotFileGovernanceText(aggregateText)) {
    return undefined;
  }

  const candidateText = [matchingSource?.text, aggregateText].filter(Boolean).join("\n");
  const filePath = extractFilePath(candidateText);
  if (!filePath) {
    return undefined;
  }

  const heuristicLabels = extractHotFileLabels(candidateText);
  if (heuristicLabels.length === 0) {
    return undefined;
  }

  return {
    file_path: filePath,
    heuristic_labels: heuristicLabels,
    result_class: HOT_FILE_RESULT_CLASS,
    reason: buildHotFileReason(candidateText),
    recommended_next_action:
      matchingSource?.assessment.recommended_next_action?.trim() ||
      aggregate.recommended_next_action?.trim() ||
      "pause and reduce scope in the pressured file before retrying"
  };
}

function weightedScore(assessments: DimensionAssessment[]): number {
  let totalWeight = 0;
  let score = 0;

  for (const assessment of assessments) {
    const weight = DIMENSION_WEIGHTS[assessment.dimension] ?? 0;
    totalWeight += weight;
    score += weight * assessment.score;
  }

  if (totalWeight <= 0) {
    return 0;
  }

  return Number((score / totalWeight).toFixed(2));
}

const SCOPE_SIGNAL_PATTERNS: RegExp[] = [
  /unrelated file mutations?/i,
  /hidden scope expansion/i,
  /scope expansion beyond/i,
  /outside the declared sub-task/i,
  /outside the declared objective/i,
  /out[- ]of[- ]scope files?/i,
  /file[- ]range overflow/i
];

const CONCRETE_RISK_PATTERNS: RegExp[] = [
  /policy violation/i,
  /budget breach/i,
  /hard[- ]budget/i,
  /guardrail/i,
  /forbidden/i,
  /unsafe/i,
  /security/i,
  /secret/i,
  /credential/i,
  /token/i,
  /password/i,
  /api key/i,
  /\bpii\b/i,
  /privacy/i,
  /data loss/i,
  /destructive/i,
  /irreversible/i,
  /rollback failed/i,
  /production/i
];

const CODEX_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /\b401\b/i,
  /unauthorized/i,
  /incorrect api key/i,
  /invalid api key/i,
  /authentication (?:failed|failure|error)/i,
  /auth\.json/i,
  /not logged in/i,
  /login required/i
];

const CODEX_TOOLING_FAILURE_PATTERNS: RegExp[] = [
  /spawn .*enoent/i,
  /\benoent\b/i,
  /command not found/i,
  /exited with code 127/i,
  /permission denied/i,
  /\beacces\b/i,
  /no such file or directory/i
];

const PROVIDER_QUOTA_FAILURE_PATTERNS: RegExp[] = [
  /\b402\b/i,
  /requires more credits/i,
  /insufficient credits/i,
  /fewer max_tokens/i,
  /\bmax_tokens\b/i,
  /credit limit/i,
  /quota/i
];

const PROVIDER_RATE_LIMIT_FAILURE_PATTERNS: RegExp[] = [
  /\b429\b/i,
  /rate_limit_error/i,
  /usage limit exceeded/i,
  /too many requests/i
];

const CODEX_PROCESS_FAILURE_PATTERNS: RegExp[] = [
  /(?:codex|ai cli) exited with code [1-9]\d*/i,
  /prompt likely exceeded/i,
  /context length/i,
  /too large/i
];

function hasPattern(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function toAssessmentText(assessment: DimensionAssessment): string {
  return [assessment.justification, ...assessment.evidence, ...assessment.blocking_issues].join("\n");
}

function extractInfrastructureDetail(assessments: DimensionAssessment[]): string | null {
  const normalized = assessments
    .map((assessment) => toAssessmentText(assessment))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  const markers = [
    "usage limit exceeded",
    "rate_limit_error",
    "too many requests",
    "api error: 429",
    "requires more credits",
    "insufficient credits",
    "max_tokens",
    "401",
    "unauthorized",
    "command not found",
    "enoent",
    "permission denied",
    "timed out",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout"
  ];
  const lower = normalized.toLowerCase();
  let markerIndex = -1;
  for (const marker of markers) {
    const index = lower.indexOf(marker);
    if (index >= 0) {
      markerIndex = index;
      break;
    }
  }

  if (markerIndex < 0) {
    return normalized.slice(0, 220);
  }

  const start = Math.max(0, markerIndex - 24);
  const end = Math.min(normalized.length, markerIndex + 180);
  return normalized.slice(start, end).trim();
}

function toLogLines(_source: "stdout" | "stderr", chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[evaluator] ${line}`);
}

function emitEvaluationLog(context: RoundEvaluationContext, message: string): void {
  if (!context.onLog) {
    return;
  }

  void Promise.resolve(context.onLog(message)).catch(() => {
    // Evaluator logging is best-effort and must never block evaluation.
  });
}

function summarizeStateChangeForEvaluation(stateChange: string): {
  changed_files: string[];
  added_lines: number;
  removed_lines: number;
  notes: string[];
} {
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

function buildArtifactManifest(context: RoundEvaluationContext): Record<string, string> {
  return {
    round_log_path: context.toolResult.artifacts.log_path || "",
    state_change_path: context.toolResult.artifacts.state_change_path || "",
    bundle_path: context.toolResult.artifacts.bundle_path || ""
  };
}

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

const ROUND_ARTIFACT_CONTRADICTION_PATTERNS: RegExp[] = [
  /claims no code change/i,
  /state-change artifact records edits/i,
  /summary and state-change artifact conflict/i,
  /no-mutation summary/i,
  /do not trust the no(?:-|\s)mutation summary/i
];

type AggregationSignals = {
  roundInconsistencySummary?: ValidationRoundInconsistencySummary;
};

function normalizePromptText(value: string): string {
  return redactSecretLikeText(value.replace(/\s+/g, " ").trim());
}

function truncatePromptText(value: string, maxLength = MAX_EXCERPT_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeNoMutationClaim(summary: string): string | null {
  const normalized = normalizePromptText(summary);
  if (!normalized || !hasPattern(NO_MUTATION_CLAIM_PATTERNS, normalized)) {
    return null;
  }

  return normalized;
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
  context: RoundEvaluationContext,
  stateChangeSummary: ReturnType<typeof summarizeStateChangeForEvaluation>,
  artifactManifest: Record<string, string>
): ValidationRoundInconsistencySummary {
  const noMutationClaim = summarizeNoMutationClaim(context.toolResult.summary);
  if (!noMutationClaim || stateChangeSummary.changed_files.length === 0) {
    return {
      status: "none",
      summary: "No round-level inconsistency detected between executor summary and recorded state-change artifact.",
      conflicting_signals: [],
      direct_evidence: []
    };
  }

  const directEvidence = collectFileScopedStateChangeExcerpts(context.stateChange, stateChangeSummary.changed_files).map(
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

function buildValidationSummary(
  context: RoundEvaluationContext,
  stateChangeSummary: ReturnType<typeof summarizeStateChangeForEvaluation>,
  artifactManifest: Record<string, string>
): Record<string, unknown> {
  const operationalEvidence = (context.toolResult.operational_evidence ?? [])
    .map((line) => normalizePromptText(line))
    .filter(Boolean);
  const logSignals = collectRelevantLogLines(context.logLines);
  const stateChangeSignals = [
    ...collectRelevantStateChangeExcerpts(context.stateChange),
    ...collectRelevantStateChangeNotes(stateChangeSummary.notes)
  ];
  const errorSignal = context.toolResult.error
    ? normalizePromptText(`${context.toolResult.error.type}: ${context.toolResult.error.message}`)
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
    const derivedSignals = [...stateChangeSignals, ...logSignals].slice(0, MAX_VALIDATION_HIGHLIGHTS);
    return {
      status: "derived",
      summary: "No explicit validation summary was attached; use the smallest executor-log and state-change excerpts selected as direct evidence.",
      primary_sources: [
        ...(logSignals.length > 0 ? ["artifact_manifest.round_log_path"] : []),
        ...(stateChangeSignals.length > 0 ? ["artifact_manifest.state_change_path"] : [])
      ],
      highlighted_signals: derivedSignals,
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
  context: RoundEvaluationContext,
  stateChangeSummary: ReturnType<typeof summarizeStateChangeForEvaluation>,
  artifactManifest: Record<string, string>,
  roundInconsistencySummary: ValidationRoundInconsistencySummary
): Array<Record<string, string>> {
  const targeted: Array<Record<string, string>> = [];
  const seen = new Set<string>();

  const addExcerpt = (input: { source: string; artifactPath: string; selectionReason: string; excerpt: string }): void => {
    if (targeted.length >= MAX_TARGETED_EXCERPTS) {
      return;
    }

    const excerpt = truncatePromptText(normalizePromptText(input.excerpt));
    if (!excerpt || seen.has(`${input.source}:${excerpt}`)) {
      return;
    }

    seen.add(`${input.source}:${excerpt}`);
    targeted.push({
      source: input.source,
      artifact_path: input.artifactPath,
      selection_reason: input.selectionReason,
      excerpt
    });
  };

  for (const evidence of roundInconsistencySummary.direct_evidence) {
    addExcerpt({
      source: "round_inconsistency_summary.direct_evidence",
      artifactPath: evidence.artifact_path,
      selectionReason:
        "Executor summary and state-change artifact conflict; include the file-scoped diff excerpt that makes the mismatch concrete.",
      excerpt: evidence.excerpt
    });
  }

  for (const line of context.toolResult.operational_evidence ?? []) {
    addExcerpt({
      source: "tool_result.operational_evidence",
      artifactPath: artifactManifest.state_change_path || artifactManifest.round_log_path || "",
      selectionReason:
        "Executor marked this as operational/validation evidence; include the shortest direct verification claim instead of the full artifact body.",
      excerpt: line
    });
  }

  if (context.toolResult.error) {
    addExcerpt({
      source: "tool_result.error",
      artifactPath: artifactManifest.round_log_path || "",
      selectionReason:
        "Executor reported a concrete failure signal; include the error itself without embedding the full round log.",
      excerpt: `${context.toolResult.error.type}: ${context.toolResult.error.message}`
    });
  }

  for (const excerpt of collectRelevantStateChangeExcerpts(context.stateChange)) {
    addExcerpt({
      source: "state_change_excerpt",
      artifactPath: artifactManifest.state_change_path || "",
      selectionReason:
        "This compact state-change excerpt shows the observable implementation surface without embedding the full diff.",
      excerpt
    });
  }

  for (const note of collectRelevantStateChangeNotes(stateChangeSummary.notes)) {
    addExcerpt({
      source: "state_change_summary.notes",
      artifactPath: artifactManifest.state_change_path || "",
      selectionReason:
        "State-change notes identify where verification or operational follow-up was recorded; include the note instead of the raw diff.",
      excerpt: note
    });
  }

  for (const line of collectRelevantLogLines(context.logLines)) {
    addExcerpt({
      source: "log_lines",
      artifactPath: artifactManifest.round_log_path || "",
      selectionReason:
        "This executor log line is a direct verification or implementation signal and is more probative than planner/process guidance.",
      excerpt: line
    });
  }

  return targeted;
}

function buildCompactEvaluationContext(context: RoundEvaluationContext): Record<string, unknown> {
  return context.validation_handoff;
}

function softenScopeOnlyHardGateFailure(assessment: DimensionAssessment): DimensionAssessment {
  if (!HARD_GATE_DIMENSIONS.has(assessment.dimension) || assessment.decision !== "fail") {
    return assessment;
  }

  const text = toAssessmentText(assessment);
  const hasScopeSignal = hasPattern(SCOPE_SIGNAL_PATTERNS, text);
  const hasConcreteRisk = hasPattern(CONCRETE_RISK_PATTERNS, text);
  if (!hasScopeSignal || hasConcreteRisk) {
    return assessment;
  }

  return {
    ...assessment,
    decision: "pass",
    score: Math.max(assessment.score, 70),
    blocking_issues: [],
    justification: `${assessment.justification} (treated as non-blocking scope signal)`,
    recommended_next_action: "narrow task scope in planning and verify behavior risk with targeted checks"
  };
}

function detectEvaluatorInfrastructureFailure(
  assessments: DimensionAssessment[]
):
  | {
      matchedAssessments: DimensionAssessment[];
      justification: string;
      rootCause: string;
      recommendedNextAction: string;
    }
  | undefined {
  const authFailures = assessments.filter((assessment) => {
    if (assessment.decision !== "unknown") {
      return false;
    }

    return hasPattern(CODEX_AUTH_FAILURE_PATTERNS, toAssessmentText(assessment));
  });
  if (authFailures.length > 0) {
    const dimensions = authFailures.map((assessment) => assessment.dimension).join(", ");
    return {
      matchedAssessments: authFailures,
      justification: `Evaluator infrastructure failure: Codex authentication failed while checking ${dimensions}.`,
      rootCause: "evaluator_infrastructure:codex_authentication",
      recommendedNextAction:
        "pause and repair evaluator Codex authentication (.ailoop/codex-home/auth.json or configured API credentials) before retrying evaluation"
    };
  }

  const toolingFailures = assessments.filter((assessment) => {
    if (assessment.decision !== "unknown") {
      return false;
    }

    return hasPattern(CODEX_TOOLING_FAILURE_PATTERNS, toAssessmentText(assessment));
  });
  if (toolingFailures.length > 0) {
    const dimensions = toolingFailures.map((assessment) => assessment.dimension).join(", ");
    return {
      matchedAssessments: toolingFailures,
      justification: `Evaluator infrastructure failure: Codex tooling was unavailable while checking ${dimensions}.`,
      rootCause: "evaluator_infrastructure:codex_tooling",
      recommendedNextAction:
        "pause and repair evaluator Codex tooling (binary path, executable permissions, and sandbox environment) before retrying evaluation"
    };
  }

  const providerQuotaFailures = assessments.filter((assessment) => {
    if (assessment.decision !== "unknown") {
      return false;
    }

    return hasPattern(PROVIDER_QUOTA_FAILURE_PATTERNS, toAssessmentText(assessment));
  });
  if (providerQuotaFailures.length > 0) {
    const dimensions = providerQuotaFailures.map((assessment) => assessment.dimension).join(", ");
    const detail = extractInfrastructureDetail(providerQuotaFailures);
    return {
      matchedAssessments: providerQuotaFailures,
      justification: `Evaluator infrastructure failure: provider credits or token limits blocked evaluation while checking ${dimensions}.${detail ? ` Detail: ${detail}` : ""}`,
      rootCause: "evaluator_infrastructure:provider_quota",
      recommendedNextAction:
        "pause and repair evaluator provider credits/quota or reduce requested max_tokens/prompt size before retrying evaluation"
    };
  }

  const providerRateLimitFailures = assessments.filter((assessment) => {
    if (assessment.decision !== "unknown") {
      return false;
    }

    return hasPattern(PROVIDER_RATE_LIMIT_FAILURE_PATTERNS, toAssessmentText(assessment));
  });
  if (providerRateLimitFailures.length > 0) {
    const dimensions = providerRateLimitFailures.map((assessment) => assessment.dimension).join(", ");
    const detail = extractInfrastructureDetail(providerRateLimitFailures);
    return {
      matchedAssessments: providerRateLimitFailures,
      justification: `Evaluator infrastructure failure: provider rate limiting blocked evaluation while checking ${dimensions}.${detail ? ` Detail: ${detail}` : ""}`,
      rootCause: "evaluator_infrastructure:provider_rate_limit",
      recommendedNextAction:
        "pause and wait for provider rate limits to recover or reduce concurrent evaluator demand before retrying evaluation"
    };
  }

  const genericProcessFailures = assessments.filter((assessment) => {
    if (assessment.decision !== "unknown") {
      return false;
    }

    return hasPattern(CODEX_PROCESS_FAILURE_PATTERNS, toAssessmentText(assessment));
  });
  if (genericProcessFailures.length > 0) {
    const dimensions = genericProcessFailures.map((assessment) => assessment.dimension).join(", ");
    const detail = extractInfrastructureDetail(genericProcessFailures);
    return {
      matchedAssessments: genericProcessFailures,
      justification: `Evaluator infrastructure failure: Codex process execution failed while checking ${dimensions}.${detail ? ` Detail: ${detail}` : ""}`,
      rootCause: "evaluator_infrastructure:codex_process_failure",
      recommendedNextAction:
        "pause and inspect evaluator Codex stderr, CLI health, and prompt size before retrying evaluation"
    };
  }

  return undefined;
}

function detectRoundArtifactContradiction(
  assessments: DimensionAssessment[]
):
  | {
      matchedAssessments: DimensionAssessment[];
      recommendedNextAction: string;
    }
  | undefined {
  const matchedAssessments = assessments.filter((assessment) =>
    hasPattern(ROUND_ARTIFACT_CONTRADICTION_PATTERNS, toAssessmentText(assessment))
  );

  if (matchedAssessments.length === 0) {
    return undefined;
  }

  return {
    matchedAssessments,
    recommendedNextAction:
      toFollowUpActions(matchedAssessments) ||
      "pause and review the recorded file edits; do not trust the no-mutation summary until governance resolves the contradiction"
  };
}

function detectObservableCausalValidityContradiction(
  signals: AggregationSignals | undefined
):
  | {
      justification: string;
      rootCause: string;
      evidence: string[];
      recommendedNextAction: string;
    }
  | undefined {
  const roundInconsistencySummary = signals?.roundInconsistencySummary;
  if (!roundInconsistencySummary || roundInconsistencySummary.status !== "present") {
    return undefined;
  }

  const evidence = [
    ...roundInconsistencySummary.conflicting_signals,
    ...roundInconsistencySummary.direct_evidence.map(
      (item) => `round_inconsistency_summary.direct_evidence: ${item.excerpt}`
    )
  ];

  return {
    justification: `Observable contradiction failed causal_validity. ${roundInconsistencySummary.summary}`,
    rootCause: "artifact_summary_conflict:no_mutation_claim",
    evidence,
    recommendedNextAction:
      "pause and review the recorded file edits; do not trust the no-mutation summary until governance resolves the contradiction"
  };
}

export function aggregateDimensionAssessments(
  assessments: DimensionAssessment[],
  minPassScore: number,
  signals?: AggregationSignals
): {
  decision: EvaluationResult["decision"];
  justification: string;
  root_cause: string;
  evidence: string[];
  recommended_next_action: string;
  recovery_path: EvaluationRecoveryPath;
  aggregateScore: number;
} {
  const normalized = assessments.map((assessment) => sanitizeDimensionAssessment(assessment.dimension, assessment));

  // Heuristic: If all scores are <= 1.0 and at least one dimension passed, it is highly likely the LLM 
  // used a 0-1 scale despite instructions. Scale them up to 0-100 to match the threshold.
  const allLowScores = normalized.every(a => a.score <= 1.0);
  const anyPassed = normalized.some(a => a.decision === "pass");
  const finalAssessments = (allLowScores && anyPassed)
    ? normalized.map(a => ({ ...a, score: a.score * 100 }))
    : normalized;

  const adjusted = finalAssessments.map(softenScopeOnlyHardGateFailure);
  const score = weightedScore(adjusted);
  const evidence = toEvidenceLines(adjusted);

  const hardGateFailure = adjusted.find(
    (assessment) => HARD_GATE_DIMENSIONS.has(assessment.dimension) && assessment.decision === "fail"
  );
  if (hardGateFailure) {
    const hardGateReason = hardGateFailure.blocking_issues[0] ?? hardGateFailure.justification;
    const followUpActions = toFollowUpActions([hardGateFailure]) || hardGateReason;
    return {
      decision: "fail",
      justification: `Hard gate failed in ${hardGateFailure.dimension}. ${hardGateReason}`,
      root_cause: `hard_gate_violation:${hardGateFailure.dimension}`,
      evidence: withDetailedEvidence([...evidence, hardGateReason], [hardGateFailure]),
      recommended_next_action: followUpActions,
      recovery_path: "tactical_rework",
      aggregateScore: score
    };
  }

  const infrastructureFailure = detectEvaluatorInfrastructureFailure(adjusted);
  if (infrastructureFailure) {
    return {
      decision: "fail",
      justification: infrastructureFailure.justification,
      root_cause: infrastructureFailure.rootCause,
      evidence: withDetailedEvidence(evidence, infrastructureFailure.matchedAssessments),
      recommended_next_action: infrastructureFailure.recommendedNextAction,
      recovery_path: "strategic_governance",
      aggregateScore: score
    };
  }

  const observableCausalValidityContradiction = detectObservableCausalValidityContradiction(signals);
  if (observableCausalValidityContradiction) {
    return {
      decision: "fail",
      justification: observableCausalValidityContradiction.justification,
      root_cause: observableCausalValidityContradiction.rootCause,
      evidence: withDetailedEvidence(
        [...evidence, ...observableCausalValidityContradiction.evidence],
        adjusted.filter((assessment) => assessment.dimension === "causal_validity")
      ),
      recommended_next_action: observableCausalValidityContradiction.recommendedNextAction,
      recovery_path: "strategic_governance",
      aggregateScore: score
    };
  }

  const roundArtifactContradiction = detectRoundArtifactContradiction(adjusted);
  if (roundArtifactContradiction) {
    return {
      decision: "fail",
      justification: "Executor summary conflicts with recorded round artifacts.",
      root_cause: "artifact_summary_conflict:no_mutation_claim",
      evidence: withDetailedEvidence(
        [...evidence, "Executor summary claims no code change, but the state-change artifact records edits."],
        roundArtifactContradiction.matchedAssessments
      ),
      recommended_next_action: roundArtifactContradiction.recommendedNextAction,
      recovery_path: "strategic_governance",
      aggregateScore: score
    };
  }

  const unknownKeyDimensions = adjusted.filter(
    (assessment) => KEY_DIMENSIONS.has(assessment.dimension) && assessment.decision === "unknown"
  );
  if (unknownKeyDimensions.length > 0) {
    const missing = unknownKeyDimensions.map((assessment) => assessment.dimension).join(", ");
    const followUpActions = toFollowUpActions(unknownKeyDimensions);
    return {
      decision: "fail",
      justification: `Insufficient evidence for key dimensions: ${missing}.`,
      root_cause: `insufficient_evidence:${unknownKeyDimensions[0].dimension}`,
      evidence: withDetailedEvidence(evidence, unknownKeyDimensions),
      recommended_next_action: followUpActions
        ? `pause and gather evidence: ${followUpActions}`
        : `pause and gather evidence: ${choosePriorityAction(unknownKeyDimensions)}`,
      recovery_path: "strategic_governance",
      aggregateScore: score
    };
  }

  const keyDimensionsWithBlockingIssues = adjusted.filter(
    (assessment) => KEY_DIMENSIONS.has(assessment.dimension) && assessment.blocking_issues.length > 0
  );
  const blockingIssue = adjusted.flatMap((assessment) => assessment.blocking_issues).find(Boolean);
  if (blockingIssue) {
    const followUpActions = toFollowUpActions(keyDimensionsWithBlockingIssues);
    const primaryDimension = keyDimensionsWithBlockingIssues[0]?.dimension ?? adjusted.find(a => a.blocking_issues.length > 0)?.dimension ?? "unknown";
    return {
      decision: "fail",
      justification: "Blocking issues were reported by dimension evaluators.",
      root_cause: `blocking_issue:${primaryDimension}`,
      evidence: withDetailedEvidence([...evidence, blockingIssue], keyDimensionsWithBlockingIssues),
      recommended_next_action: followUpActions || blockingIssue,
      recovery_path: "tactical_rework",
      aggregateScore: score
    };
  }

  const failedDimensions = adjusted.filter((assessment) => assessment.decision === "fail");
  if (failedDimensions.length > 0) {
    const failedKeyDimensions = failedDimensions.filter((assessment) => KEY_DIMENSIONS.has(assessment.dimension));
    const followUpActions = toFollowUpActions(failedKeyDimensions);
    return {
      decision: "fail",
      justification: `One or more dimensions failed: ${failedDimensions.map((item) => item.dimension).join(", ")}.`,
      root_cause: `dimension_failure:${failedDimensions[0].dimension}`,
      evidence: withDetailedEvidence(evidence, failedKeyDimensions),
      recommended_next_action: followUpActions || choosePriorityAction(failedDimensions),
      recovery_path: "tactical_rework",
      aggregateScore: score
    };
  }

  if (score < minPassScore) {
    return {
      decision: "fail",
      justification: `Aggregate score ${score.toFixed(2)} is below threshold ${minPassScore.toFixed(2)}.`,
      root_cause: "low_aggregate_score",
      evidence,
      recommended_next_action: choosePriorityAction(adjusted),
      recovery_path: "tactical_rework",
      aggregateScore: score
    };
  }

  return {
    decision: "pass",
    justification: `All evaluated dimensions passed with aggregate score ${score.toFixed(2)}.`,
    root_cause: "none",
    evidence,
    recommended_next_action: "continue",
    recovery_path: "tactical_rework",
    aggregateScore: score
  };
}

export function buildDimensionPrompt(
  dimension: EvaluationDimension,
  context: RoundEvaluationContext,
  evaluatorRoleDefinition = ""
): string {
  const decisionExamples = DIMENSION_DECISION_EXAMPLES[dimension] ?? [];
  return [
    `You are an AILoop evaluator for dimension: ${dimension}.`,
    ...(evaluatorRoleDefinition.trim()
      ? ["Project-specific Evaluator Role Definition:", evaluatorRoleDefinition.trim(), ""]
      : []),
    "Runtime execution notes:",
    "- This internal runtime session is intentionally isolated from repository-local AGENTS.md files and development-assistant skill workflows.",
    "- Do not inspect repository files or use external development-assistant skills. Judge only from the provided prompt context.",
    "- Do not use collaborative brainstorming workflows, human question-asking patterns, or external skill mandates.",
    "",
    "Return JSON matching schema only.",
    "",
    "Rules:",
    "- Evidence first, skeptical by default.",
    "- Do not infer hidden work.",
    "- If evidence is insufficient, return decision=unknown.",
    "- Judge only against provided context.",
    "- Use a 0-100 scale for scores (75 is the default passing threshold).",
    "",
    "Evidence priority:",
    ...EVIDENCE_PRIORITY_LINES.map((line) => `- ${line}`),
    "",
    "Dimension guidance:",
    ...DIMENSION_GUIDANCE[dimension].map((line) => `- ${line}`),
    ...(decisionExamples.length > 0
      ? [
          "",
          "Decision examples:",
          ...decisionExamples.map((line) => `- ${line}`)
        ]
      : []),
    "",
    "Round context:",
    JSON.stringify(buildCompactEvaluationContext(context), null, 2)
  ].join("\n");
}

export class LLMJudgeEvaluator implements Evaluator {
  private readonly codex: AIClient;
  private readonly sandbox: AppConfig["ai"]["evaluatorSandbox"];
  private readonly dimensions: EvaluationDimension[];
  private readonly minPassScore: number;
  private readonly homeDir: string;

  constructor(config: AppConfig, aiClient?: AIClient) {
    this.ai = aiClient ?? new AIClient(config.ai);
    this.sandbox = config.ai.evaluatorSandbox;
    this.dimensions = [...config.ai.llmEvaluatorDimensions];
    this.minPassScore = config.ai.llmEvaluatorMinPassScore;
    this.homeDir = config.homeDir;
  }

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    const assessments: DimensionAssessment[] = [];
    const evaluatorRoleDefinition = await loadProjectRoleDefinition(this.homeDir, "evaluator");
    const roundInconsistencySummary = context.validation_handoff.round_inconsistency_summary;
    emitEvaluationLog(context, "Evaluator started LLM dimension checks.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitEvaluationLog(context, `Evaluator running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    try {
      for (const dimension of this.dimensions) {
        emitEvaluationLog(context, `Evaluator checking dimension: ${dimension}.`);
        const aiResult = await this.ai.runJson<DimensionAssessment>({
          prompt: buildDimensionPrompt(dimension, context, evaluatorRoleDefinition),
          schema: DIMENSION_SCHEMA,
          cwd: process.cwd(),
          sandbox: this.sandbox,
          sessionIsolation: {
            enabled: true,
            agentsGuide: buildInternalRuntimeSessionGuide("Evaluator", [
              "Do not inspect repository files. Judge only from the provided prompt context."
            ])
          },
          onStdoutChunk: (chunk) => {
            for (const line of toLogLines("stdout", chunk)) {
              emitEvaluationLog(context, line);
            }
          },
          onStderrChunk: (chunk) => {
            for (const line of toLogLines("stderr", chunk)) {
              emitEvaluationLog(context, line);
            }
          }
        });

        if (!aiResult.ok || !aiResult.data) {
          emitEvaluationLog(
            context,
            `Evaluator dimension ${dimension} failed (error=${
              aiResult.error ?? "missing evaluator JSON payload"
            }).`
          );
          const evidence = [aiResult.error, aiResult.stderr, aiResult.rawMessage].filter(Boolean).map((item) => String(item));
          const failedAssessment = sanitizeDimensionAssessment(dimension, {
            dimension,
            decision: "unknown",
            score: 0,
            confidence: 0,
            justification: "Dimension evaluator call failed.",
            evidence: evidence.length > 0 ? evidence : ["Evaluator response unavailable"],
            blocking_issues: [],
            recommended_next_action: "pause and inspect evaluator failure"
          });
          assessments.push(failedAssessment);
          const infrastructureFailure = detectEvaluatorInfrastructureFailure([failedAssessment]);
          if (infrastructureFailure) {
            emitEvaluationLog(
              context,
              `Evaluator detected infrastructure failure (${infrastructureFailure.rootCause}); aborting remaining dimension checks.`
            );
            break;
          }
          continue;
        }

        const normalized = sanitizeDimensionAssessment(dimension, aiResult.data);
        assessments.push(normalized);
        emitEvaluationLog(
          context,
          `Evaluator dimension ${dimension} result: ${normalized.decision} (score=${normalized.score.toFixed(1)}, confidence=${normalized.confidence.toFixed(2)}).`
        );
      }
    } finally {
      clearInterval(heartbeat);
    }

    const aggregate = aggregateDimensionAssessments(assessments, this.minPassScore, {
      roundInconsistencySummary
    });
    emitEvaluationLog(context, `Evaluator completed LLM dimension checks (decision=${aggregate.decision}).`);
    const hotFileGovernance = detectHotFileGovernance(assessments, aggregate);
    const recoveryPath = hotFileGovernance ? "strategic_governance" : aggregate.recovery_path;
    return {
      decision: aggregate.decision,
      justification: aggregate.justification,
      root_cause: aggregate.root_cause,
      evidence: aggregate.evidence,
      recommended_next_action: aggregate.recommended_next_action,
      recovery_path: recoveryPath,
      dimensions: assessments,
      aggregate_score: aggregate.aggregateScore,
      hot_file_governance: hotFileGovernance ?? null
    };
  }
}
