import { describe, expect, test } from "bun:test";
import type { DimensionAssessment } from "../../types/contracts";
import { aggregateDimensionAssessments } from "./llm-judge";

function makeAssessment(partial: Partial<DimensionAssessment> & Pick<DimensionAssessment, "dimension">): DimensionAssessment {
  return {
    dimension: partial.dimension,
    decision: partial.decision ?? "pass",
    score: partial.score ?? 80,
    confidence: partial.confidence ?? 0.8,
    justification: partial.justification ?? "ok",
    evidence: partial.evidence ?? ["evidence"],
    blocking_issues: partial.blocking_issues ?? [],
    recommended_next_action: partial.recommended_next_action ?? "continue"
  };
}

describe("aggregateDimensionAssessments", () => {
  test("fails immediately when constraint_compliance fails", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 90 }),
        makeAssessment({ dimension: "constraint_compliance", decision: "fail", score: 20, blocking_issues: ["policy violation"] }),
        makeAssessment({ dimension: "risk_externality", score: 85 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Hard gate");
    expect(result.recommended_next_action).toContain("policy violation");
  });

  test("fails with pause recommendation when key dimension is unknown", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", decision: "unknown", score: 0, recommended_next_action: "collect KPI evidence" }),
        makeAssessment({ dimension: "causal_validity", score: 78 }),
        makeAssessment({ dimension: "constraint_compliance", score: 92 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Insufficient evidence");
    expect(result.recommended_next_action).toContain("pause");
  });

  test("passes when weighted score meets threshold and no blockers", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 85 }),
        makeAssessment({ dimension: "causal_validity", score: 82 }),
        makeAssessment({ dimension: "constraint_compliance", score: 90 }),
        makeAssessment({ dimension: "risk_externality", score: 80 }),
        makeAssessment({ dimension: "reversibility_resilience", score: 75 }),
        makeAssessment({ dimension: "learning_yield", score: 72 })
      ],
      75
    );

    expect(result.decision).toBe("pass");
    expect(result.aggregateScore).toBeGreaterThanOrEqual(75);
  });
});
