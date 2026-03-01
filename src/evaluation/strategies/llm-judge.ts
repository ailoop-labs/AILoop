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
    "Fail on any concrete policy or hard-budget violation."
  ],
  risk_externality: [
    "Assess newly introduced risks and negative side effects.",
    "Fail when severe unresolved risk is introduced."
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
  const score = weightedScore(normalized);
  const evidence = toEvidenceLines(normalized);

  const hardGateFailure = normalized.find(
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

  const unknownKeyDimensions = normalized.filter(
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

  const blockingIssue = normalized.flatMap((assessment) => assessment.blocking_issues).find(Boolean);
  if (blockingIssue) {
    return {
      decision: "fail",
      justification: "Blocking issues were reported by dimension evaluators.",
      evidence: [...evidence, blockingIssue],
      recommended_next_action: blockingIssue,
      aggregateScore: score
    };
  }

  const failedDimensions = normalized.filter((assessment) => assessment.decision === "fail");
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
      recommended_next_action: choosePriorityAction(normalized),
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

function buildDimensionPrompt(dimension: EvaluationDimension, context: RoundEvaluationContext): string {
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
    "Dimension guidance:",
    ...DIMENSION_GUIDANCE[dimension].map((line) => `- ${line}`),
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

    for (const dimension of this.dimensions) {
      const codexResult = await this.codex.runJson<DimensionAssessment>({
        prompt: buildDimensionPrompt(dimension, context),
        schema: DIMENSION_SCHEMA,
        cwd: process.cwd(),
        sandbox: this.sandbox
      });

      if (!codexResult.ok || !codexResult.data) {
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

      assessments.push(sanitizeDimensionAssessment(dimension, codexResult.data));
    }

    const aggregate = aggregateDimensionAssessments(assessments, this.minPassScore);
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
