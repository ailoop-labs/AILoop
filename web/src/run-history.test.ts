import { describe, expect, test } from "bun:test";
import { projectRunHistoryReport, type RunHistoryItem } from "./run-history";

function makeSummary(): string {
  return `# AILoop Round Summary

## Task
- Objective: Ship evaluator data into the web console
- Expected Outcome: Run history reads evaluator artifacts directly

## Execution
- Tool Status: success
- Work Summary: Updated the run history view
- Error: none

## Evaluation
- Decision: fail
- Justification: Parsed markdown should only be fallback data.
- Evidence: bun test web/src/App.test.tsx

## Budget
- Cost USD: 0.12
- Time ms: 4200
- Actions: 7

## Next Round Recommendation
Fallback next step from summary`;
}

describe("projectRunHistoryReport", () => {
  test("prefers structured evaluation fields when the API payload includes them", () => {
    const run: RunHistoryItem = {
      timestamp: "2026-03-10T10-00-00-000Z",
      summary: makeSummary(),
      metrics: null,
      evaluation: {
        decision: "pass",
        justification: "Structured evaluation should override summary parsing.",
        evidence: ["bun test web/src/run-history.test.ts", "bun run web:build"],
        recommended_next_action: "Proceed to the next planner task."
      }
    };

    const report = projectRunHistoryReport(run);

    expect(report.objective).toBe("Ship evaluator data into the web console");
    expect(report.expectedOutcome).toBe("Run history reads evaluator artifacts directly");
    expect(report.toolStatus).toBe("success");
    expect(report.workSummary).toBe("Updated the run history view");
    expect(report.error).toBe("none");
    expect(report.decision).toBe("pass");
    expect(report.justification).toBe("Structured evaluation should override summary parsing.");
    expect(report.evidence).toBe("bun test web/src/run-history.test.ts | bun run web:build");
    expect(report.nextRecommendation).toBe("Proceed to the next planner task.");
  });

  test("falls back to summary parsing when evaluation artifacts are missing", () => {
    const run: RunHistoryItem = {
      timestamp: "2026-03-10T10-00-00-000Z",
      summary: makeSummary(),
      metrics: null,
      evaluation: null
    };

    const report = projectRunHistoryReport(run);

    expect(report.decision).toBe("fail");
    expect(report.justification).toBe("Parsed markdown should only be fallback data.");
    expect(report.evidence).toBe("bun test web/src/App.test.tsx");
    expect(report.nextRecommendation).toBe("Fallback next step from summary");
  });
});
