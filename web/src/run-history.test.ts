import { describe, expect, test } from "bun:test";
import { projectRunHistoryReport, type RunHistoryItem } from "./run-history";

function makeSummary(): string {
  return `# AILoop Round Summary

## Planned Sub-task
- Objective: Ship evaluator data into the web console
- Expected Outcome: Run history reads evaluator artifacts directly
- Rationale: Keep round reviews scannable.

## Executor Action Trace
1. read_file: Inspected persisted round summary formatting.
2. write_file: Added evidence section parsing for the console.

## Execution Result
- Tool Status: success
- Work Summary: Updated the run history view
- Error: none

## Operational Evidence
- Verification: bun test web/src/run-history.test.ts -> 2 passed
- Follow-up: Surface executor and verification evidence in run detail

## Verification Evidence
- bun test web/src/run-history.test.ts
- bun --cwd=web run build

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
        aggregate_score: 96,
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "pass",
            score: 98,
            confidence: 0.92,
            justification: "The change directly exposes evaluator artifacts in the console.",
            evidence: ["rendered aggregate score", "rendered per-dimension status"],
            blocking_issues: [],
            recommended_next_action: "continue"
          },
          {
            dimension: "constraint_compliance",
            decision: "fail",
            score: 61,
            confidence: 0.88,
            justification: "One validation path still needs explicit evidence.",
            evidence: ["missing build proof"],
            blocking_issues: ["No end-to-end artifact confirmation yet."],
            recommended_next_action: "Run the build and attach the output."
          }
        ],
        recommended_next_action: "Proceed to the next planner task."
      }
    };

    const report = projectRunHistoryReport(run);

    expect(report.objective).toBe("Ship evaluator data into the web console");
    expect(report.expectedOutcome).toBe("Run history reads evaluator artifacts directly");
    expect(report.toolStatus).toBe("success");
    expect(report.workSummary).toBe("Updated the run history view");
    expect(report.error).toBe("none");
    expect(report.executorActionTrace).toEqual([
      "read_file: Inspected persisted round summary formatting.",
      "write_file: Added evidence section parsing for the console."
    ]);
    expect(report.operationalEvidence).toEqual([
      "Verification: bun test web/src/run-history.test.ts -> 2 passed",
      "Follow-up: Surface executor and verification evidence in run detail"
    ]);
    expect(report.verificationEvidence).toEqual([
      "bun test web/src/run-history.test.ts",
      "bun --cwd=web run build"
    ]);
    expect(report.decision).toBe("pass");
    expect(report.justification).toBe("Structured evaluation should override summary parsing.");
    expect(report.evidence).toBe("bun test web/src/run-history.test.ts | bun run web:build");
    expect(report.aggregateScore).toBe("96");
    expect(report.nextRecommendation).toBe("Proceed to the next planner task.");
    expect(report.dimensionBreakdown).toEqual([
      {
        label: "Goal Alignment",
        decision: "pass",
        score: "98",
        confidence: "0.92",
        justification: "The change directly exposes evaluator artifacts in the console.",
        evidence: "rendered aggregate score | rendered per-dimension status",
        blockingIssues: "None",
        nextRecommendation: "continue"
      },
      {
        label: "Constraint Compliance",
        decision: "fail",
        score: "61",
        confidence: "0.88",
        justification: "One validation path still needs explicit evidence.",
        evidence: "missing build proof",
        blockingIssues: "No end-to-end artifact confirmation yet.",
        nextRecommendation: "Run the build and attach the output."
      }
    ]);
  });

  test("falls back to summary parsing when evaluation artifacts are missing", () => {
    const run: RunHistoryItem = {
      timestamp: "2026-03-10T10-00-00-000Z",
      summary: makeSummary(),
      metrics: null,
      evaluation: null
    };

    const report = projectRunHistoryReport(run);

    expect(report.executorActionTrace).toEqual([
      "read_file: Inspected persisted round summary formatting.",
      "write_file: Added evidence section parsing for the console."
    ]);
    expect(report.operationalEvidence).toEqual([
      "Verification: bun test web/src/run-history.test.ts -> 2 passed",
      "Follow-up: Surface executor and verification evidence in run detail"
    ]);
    expect(report.verificationEvidence).toEqual([
      "bun test web/src/run-history.test.ts",
      "bun --cwd=web run build"
    ]);
    expect(report.decision).toBe("fail");
    expect(report.justification).toBe("Parsed markdown should only be fallback data.");
    expect(report.evidence).toBe("bun test web/src/App.test.tsx");
    expect(report.aggregateScore).toBe("N/A");
    expect(report.dimensionBreakdown).toEqual([]);
    expect(report.nextRecommendation).toBe("Fallback next step from summary");
  });
});
