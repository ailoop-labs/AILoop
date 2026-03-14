import { describe, expect, test } from "bun:test";
import type { PlannerContext } from "../types/contracts";
import { buildAdaptivePlannerDirectives, buildPlannerPrompt, resolvePlannerRequirementMode } from "./planner";

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
    requirement_artifact_status: "ready",
    requirement_artifact_summary: null,
    ...overrides
  };
}

describe("resolvePlannerRequirementMode", () => {
  test("requests requirement creation when no active requirement artifact exists", () => {
    expect(
      resolvePlannerRequirementMode(
        createContext({
          requirement_artifact_status: "missing"
        })
      )
    ).toBe("create_requirement");
  });

  test("requests requirement refresh when the active slice is exhausted or insufficient", () => {
    expect(
      resolvePlannerRequirementMode(
        createContext({
          requirement_artifact_status: "needs_refresh"
        })
      )
    ).toBe("refresh_requirement");
  });

  test("stays in normal execution mode when a requirement slice is available", () => {
    expect(resolvePlannerRequirementMode(createContext())).toBe("normal_execution");
  });
});

describe("buildAdaptivePlannerDirectives", () => {
  test("adds implementation-first directive after repeated evaluator failures", () => {
    const directives = buildAdaptivePlannerDirectives(
      createContext({
        consecutive_evaluator_failures: 3,
        previous_round_error: "No observable file creation or content diff for `.ailoop/plans/round-5-core-loop-baseline.md`."
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

  test("adds a requirement lifecycle directive when the active requirement artifact is missing", () => {
    const directives = buildAdaptivePlannerDirectives(
      createContext({
        requirement_artifact_status: "missing"
      })
    );

    expect(directives.join("\n")).toContain(".ailoop/product-requirements/current.md");
  });
});

describe("buildPlannerPrompt", () => {
  test("injects project-specific planner role definition block", () => {
    const prompt = buildPlannerPrompt(createContext(), [], "# Planner Role\n\nProject-specific planner instructions.");
    expect(prompt).toContain("Project-specific Planner Role Definition");
    expect(prompt).toContain("Project-specific planner instructions.");
  });

  test("includes requirement artifact status and summary in planner input", () => {
    const prompt = buildPlannerPrompt(
      createContext({
        requirement_artifact_status: "needs_refresh",
        requirement_artifact_summary: "Current slice shipped console health checks but lacks operator-facing UX acceptance."
      }),
      [],
      "# Planner Role\n\nProject-specific planner instructions."
    );

    expect(prompt).toContain("\"requirement_artifact_status\": \"needs_refresh\"");
    expect(prompt).toContain("lacks operator-facing UX acceptance");
  });
});
