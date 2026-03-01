import type { AppConfig } from "../../config/env";
import type {
  DimensionAssessment,
  EvaluationDimension,
  EvaluationResult,
  RoundEvaluationContext
} from "../../types/contracts";
import { CodexClient, type JsonSchema } from "../../agent/codex-client";
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
  const justification = typeof candidate?.justification === "string" ? candidate.justification.trim() : "";
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence.map((item) => String(item)).filter(Boolean) : [];
  const blockingIssues = Array.isArray(candidate?.blocking_issues)
    ? candidate.blocking_issues.map((item) => String(item)).filter(Boolean)
    : [];
  const recommendedNextAction =
    typeof candidate?.recommended_next_action === "string" && candidate.recommended_next_action.trim()
      ? candidate.recommended_next_action.trim()
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

export function aggregateDimensionAssessments(
  assessments: DimensionAssessment[],
  minPassScore: number
): {
  decision: EvaluationResult["decision"];
  justification: string;
  evidence: string[];
  recommended_next_action: string;
  aggregateScore: number;
} {
  const normalized = assessments.map((assessment) => sanitizeDimensionAssessment(assessment.dimension, assessment));
  const adjusted = normalized.map(softenScopeOnlyHardGateFailure);
  const score = weightedScore(adjusted);
  const evidence = toEvidenceLines(adjusted);

  const hardGateFailure = adjusted.find(
    (assessment) => HARD_GATE_DIMENSIONS.has(assessment.dimension) && assessment.decision === "fail"
  );
  if (hardGateFailure) {
    const hardGateReason = hardGateFailure.blocking_issues[0] ?? hardGateFailure.justification;
    return {
      decision: "fail",
      justification: `Hard gate failed in ${hardGateFailure.dimension}.`,
      evidence: [...evidence, hardGateReason],
      recommended_next_action: hardGateReason,
      aggregateScore: score
    };
  }

  const unknownKeyDimensions = adjusted.filter(
    (assessment) => KEY_DIMENSIONS.has(assessment.dimension) && assessment.decision === "unknown"
  );
  if (unknownKeyDimensions.length > 0) {
    const missing = unknownKeyDimensions.map((assessment) => assessment.dimension).join(", ");
    return {
      decision: "fail",
      justification: `Insufficient evidence for key dimensions: ${missing}.`,
      evidence,
      recommended_next_action: `pause and gather evidence: ${choosePriorityAction(unknownKeyDimensions)}`,
      aggregateScore: score
    };
  }

  const blockingIssue = adjusted.flatMap((assessment) => assessment.blocking_issues).find(Boolean);
  if (blockingIssue) {
    return {
      decision: "fail",
      justification: "Blocking issues were reported by dimension evaluators.",
      evidence: [...evidence, blockingIssue],
      recommended_next_action: blockingIssue,
      aggregateScore: score
    };
  }

  const failedDimensions = adjusted.filter((assessment) => assessment.decision === "fail");
  if (failedDimensions.length > 0) {
    return {
      decision: "fail",
      justification: `One or more dimensions failed: ${failedDimensions.map((item) => item.dimension).join(", ")}.`,
      evidence,
      recommended_next_action: choosePriorityAction(failedDimensions),
      aggregateScore: score
    };
  }

  if (score < minPassScore) {
    return {
      decision: "fail",
      justification: `Aggregate score ${score.toFixed(2)} is below threshold ${minPassScore.toFixed(2)}.`,
      evidence,
      recommended_next_action: choosePriorityAction(adjusted),
      aggregateScore: score
    };
  }

  return {
    decision: "pass",
    justification: `All evaluated dimensions passed with aggregate score ${score.toFixed(2)}.`,
    evidence,
    recommended_next_action: "continue",
    aggregateScore: score
  };
}

export function buildDimensionPrompt(dimension: EvaluationDimension, context: RoundEvaluationContext): string {
  const decisionExamples = DIMENSION_DECISION_EXAMPLES[dimension] ?? [];
  return [
    `You are an AutoLoop evaluator for dimension: ${dimension}.`,
    "Return JSON matching schema only.",
    "",
    "Rules:",
    "- Evidence first, skeptical by default.",
    "- Do not infer hidden work.",
    "- If evidence is insufficient, return decision=unknown.",
    "- Judge only against provided context.",
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

  constructor(config: AppConfig, codexClient?: CodexClient) {
    this.codex = codexClient ?? new CodexClient(config.codex);
    this.sandbox = config.codex.evaluatorSandbox;
    this.dimensions = [...config.codex.llmEvaluatorDimensions];
    this.minPassScore = config.codex.llmEvaluatorMinPassScore;
  }

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    const assessments: DimensionAssessment[] = [];
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
          prompt: buildDimensionPrompt(dimension, context),
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
      evidence: aggregate.evidence,
      recommended_next_action: aggregate.recommended_next_action,
      dimensions: assessments,
      aggregate_score: aggregate.aggregateScore
    };
  }
}
