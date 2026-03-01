import { describe, expect, test } from "bun:test";
import type { PlannerContext } from "../types/contracts";
import { buildAdaptivePlannerDirectives } from "./planner";

function createContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    goal: "Improve core loop implementation.",
    instructions: [],
    round: 8,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    previous_tool_result: null,
    previous_round_error: null,
    consecutive_evaluator_failures: 0,
    ...overrides
  };
}

describe("buildAdaptivePlannerDirectives", () => {
  test("adds implementation-first directive after repeated evaluator failures", () => {
    const directives = buildAdaptivePlannerDirectives(
      createContext({
        consecutive_evaluator_failures: 3,
        previous_round_error: "No observable file creation or content diff for `.autoloop/plans/round-5-core-loop-baseline.md`."
      })
    );

    const joined = directives.join("\n");
    expect(joined).toContain("Do not output documentation-only audit/checklist/report tasks");
    expect(joined).toContain("src/");
    expect(joined).toContain("scripts/");
  });

  test("keeps base directives when no failure signal exists", () => {
    const directives = buildAdaptivePlannerDirectives(createContext());
    expect(directives.length).toBe(0);
  });
});
