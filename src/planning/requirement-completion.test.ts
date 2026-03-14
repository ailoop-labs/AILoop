import { describe, expect, test } from "bun:test";
import type { EvaluationResult, ToolResult } from "../types/contracts";
import {
  assessRequirementCompletion,
  getRequirementLifecycleStatus,
  upsertRequirementLifecycleStatus
} from "./requirement-completion";

function makeToolResult(nextStateHint: ToolResult["next_state_hint"] = "continue"): ToolResult {
  return {
    status: "success",
    summary: "Recorded completion evidence for the active requirement slice.",
    artifacts: {
      log_path: "",
      state_change_path: ""
    },
    next_state_hint: nextStateHint
  };
}

function makeEvaluation(decision: EvaluationResult["decision"], evidence: string[]): EvaluationResult {
  return {
    decision,
    justification: evidence[0] ?? "No evidence recorded.",
    evidence,
    recommended_next_action: decision === "pass" ? "continue" : "add missing evidence"
  };
}

describe("requirement completion heuristics", () => {
  const requirementMarkdown = [
    "# Requirement Slice: Requirement Lifecycle",
    "",
    "## Acceptance Criteria",
    "- requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
    "- ProjectPlanner requests a ProductManager refresh after the current slice is complete.",
    "",
    "## Completion Notes",
    "- This slice is complete when the acceptance criteria above are satisfied."
  ].join("\n");

  test("marks a requirement slice complete when all acceptance criteria are evidenced on a passing round", () => {
    const result = assessRequirementCompletion({
      requirementMarkdown,
      evaluation: makeEvaluation("pass", [
        "requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        "ProjectPlanner requests a ProductManager refresh after the current slice is complete."
      ]),
      toolResult: makeToolResult(),
      stateChange:
        "Updated src/planning/requirement-completion.ts so ProjectPlanner requests a ProductManager refresh after the current slice is complete."
    });

    expect(result.isComplete).toBe(true);
    expect(result.unmatchedCriteria).toEqual([]);
    expect(result.matchedCriteria).toHaveLength(2);
  });

  test("keeps the requirement slice in progress when a passing round does not evidence every acceptance criterion", () => {
    const result = assessRequirementCompletion({
      requirementMarkdown,
      evaluation: makeEvaluation("pass", [
        "requirement-completion.ts records a lifecycle status update for the active requirement artifact."
      ]),
      toolResult: makeToolResult(),
      stateChange: "Updated src/planning/requirement-completion.ts with lifecycle status support."
    });

    expect(result.isComplete).toBe(false);
    expect(result.unmatchedCriteria).toEqual([
      "ProjectPlanner requests a ProductManager refresh after the current slice is complete."
    ]);
  });

  test("does not mark completion when evaluator failed even if the evidence text overlaps with the acceptance criteria", () => {
    const result = assessRequirementCompletion({
      requirementMarkdown,
      evaluation: makeEvaluation("fail", [
        "requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        "ProjectPlanner requests a ProductManager refresh after the current slice is complete."
      ]),
      toolResult: makeToolResult(),
      stateChange:
        "Updated src/planning/requirement-completion.ts so ProjectPlanner requests a ProductManager refresh after the current slice is complete."
    });

    expect(result.isComplete).toBe(false);
    expect(result.reason).toContain("Evaluator did not pass");
  });

  test("writes a stable lifecycle status section into the requirement artifact", () => {
    const completion = assessRequirementCompletion({
      requirementMarkdown,
      evaluation: makeEvaluation("pass", [
        "requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        "ProjectPlanner requests a ProductManager refresh after the current slice is complete."
      ]),
      toolResult: makeToolResult(),
      stateChange:
        "Updated src/planning/requirement-completion.ts so ProjectPlanner requests a ProductManager refresh after the current slice is complete."
    });

    const updated = upsertRequirementLifecycleStatus(requirementMarkdown, completion, 4);

    expect(getRequirementLifecycleStatus(updated)).toBe("complete");
    expect(updated).toContain("## Lifecycle Status");
    expect(updated).toContain("- Status: complete");
    expect(updated).toContain("- Completed In Round: 4");
  });
});
