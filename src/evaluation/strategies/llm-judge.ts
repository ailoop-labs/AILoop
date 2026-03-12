import type { AppConfig } from "../../config/env";
import { resolveCodexBin } from "../../config/env";
import type {
  DimensionAssessment,
  EvaluationDimension,
  EvaluationResult,
  RoundEvaluationContext
} from "../../types/contracts";
import { CodexClient, type JsonSchema } from "../../agent/codex-client";
import { loadProjectRoleDefinition } from "../../agent/role-definitions";
import { redactSecretLikeText } from "../../secret-redaction";
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function hasPattern(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function toAssessmentText(assessment: DimensionAssessment): string {
  return [assessment.justification, ...assessment.evidence, ...assessment.blocking_issues].join("\n");
}

function toLogLines(source: "stdout" | "stderr", chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[evaluator codex ${source}] ${line}`);
}

function emitEvaluationLog(context: RoundEvaluationContext, message: string): void {
  if (!context.onLog) {
    return;
  }

  void Promise.resolve(context.onLog(message)).catch(() => {
    // Evaluator logging is best-effort and must never block evaluation.
  });
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

  return undefined;
}

export function aggregateDimensionAssessments(
  assessments: DimensionAssessment[],
  minPassScore: number
): {
  decision: EvaluationResult["decision"];
  justification: string;
  root_cause: string;
  evidence: string[];
  recommended_next_action: string;
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
      aggregateScore: score
    };
  }

  return {
    decision: "pass",
    justification: `All evaluated dimensions passed with aggregate score ${score.toFixed(2)}.`,
    root_cause: "none",
    evidence,
    recommended_next_action: "continue",
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
    JSON.stringify(
      {
        objective: context.subTask.objective,
        expected_outcome: context.subTask.expected_outcome,
        tool_result: context.toolResult,
        budget_limits: context.budgetLimits,
        budget_usage: context.budgetUsage,
        state_change: context.stateChange,
        recent_logs: context.logLines.slice(-40)
      },
      null,
      2
    )
  ].join("\n");
}

export class LLMJudgeEvaluator implements Evaluator {
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["evaluatorSandbox"];
  private readonly dimensions: EvaluationDimension[];
  private readonly minPassScore: number;
  private readonly homeDir: string;

  constructor(config: AppConfig, codexClient?: CodexClient) {
    this.codex = codexClient ?? new CodexClient({
      ...config.codex,
      bin: resolveCodexBin(config.codex)
    });
    this.sandbox = config.codex.evaluatorSandbox;
    this.dimensions = [...config.codex.llmEvaluatorDimensions];
    this.minPassScore = config.codex.llmEvaluatorMinPassScore;
    this.homeDir = config.homeDir;
  }

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    const assessments: DimensionAssessment[] = [];
    const evaluatorRoleDefinition = await loadProjectRoleDefinition(this.homeDir, "evaluator");
    emitEvaluationLog(context, "Evaluator started LLM dimension checks.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitEvaluationLog(context, `Evaluator running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    try {
      for (const dimension of this.dimensions) {
        emitEvaluationLog(context, `Evaluator checking dimension: ${dimension}.`);
        const codexResult = await this.codex.runJson<DimensionAssessment>({
          prompt: buildDimensionPrompt(dimension, context, evaluatorRoleDefinition),
          schema: DIMENSION_SCHEMA,
          cwd: process.cwd(),
          sandbox: this.sandbox,
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

        if (!codexResult.ok || !codexResult.data) {
          emitEvaluationLog(
            context,
            `Evaluator dimension ${dimension} failed (error=${
              codexResult.error ?? "missing evaluator JSON payload"
            }).`
          );
          const evidence = [codexResult.error, codexResult.stderr].filter(Boolean).map((item) => String(item));
          assessments.push(
            sanitizeDimensionAssessment(dimension, {
              dimension,
              decision: "unknown",
              score: 0,
              confidence: 0,
              justification: "Dimension evaluator call failed.",
              evidence: evidence.length > 0 ? evidence : ["Evaluator response unavailable"],
              blocking_issues: [],
              recommended_next_action: "pause and inspect evaluator failure"
            })
          );
          continue;
        }

        const normalized = sanitizeDimensionAssessment(dimension, codexResult.data);
        assessments.push(normalized);
        emitEvaluationLog(
          context,
          `Evaluator dimension ${dimension} result: ${normalized.decision} (score=${normalized.score.toFixed(1)}, confidence=${normalized.confidence.toFixed(2)}).`
        );
      }
    } finally {
      clearInterval(heartbeat);
    }

    const aggregate = aggregateDimensionAssessments(assessments, this.minPassScore);
    emitEvaluationLog(context, `Evaluator completed LLM dimension checks (decision=${aggregate.decision}).`);
    return {
      decision: aggregate.decision,
      justification: aggregate.justification,
      root_cause: aggregate.root_cause,
      evidence: aggregate.evidence,
      recommended_next_action: aggregate.recommended_next_action,
      dimensions: assessments,
      aggregate_score: aggregate.aggregateScore
    };
  }
}
