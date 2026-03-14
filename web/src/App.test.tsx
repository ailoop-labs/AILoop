import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunArtifactEvidenceGrid } from "./App";
import type { RoundReport } from "./run-history";

function makeReport(overrides: Partial<RoundReport> = {}): RoundReport {
  return {
    objective: "Expose round evidence in the console",
    expectedOutcome: "Operators can review evidence without reading raw markdown",
    toolStatus: "success",
    workSummary: "Rendered structured evidence blocks",
    error: "none",
    executorActionTrace: [
      "read_file: Inspected persisted round summary formatting.",
      "write_file: Added evidence cards to the run detail modal."
    ],
    operationalEvidence: [
      "Follow-up: Verify the run detail modal remains scannable."
    ],
    verificationEvidence: [
      "bun test ./web/src/run-history.test.ts",
      "bun test ./web/src/App.test.tsx"
    ],
    decision: "pass",
    justification: "The console now surfaces structured round evidence.",
    rootCause: "none",
    evidence: "bun test ./web/src/App.test.tsx",
    aggregateScore: "95",
    budgetCost: "0.08",
    budgetTime: "3200",
    budgetActions: "4",
    dimensionBreakdown: [],
    nextRecommendation: "Continue",
    ...overrides
  };
}

describe("RunArtifactEvidenceGrid", () => {
  test("renders populated evidence blocks as compact labeled cards", () => {
    const html = renderToStaticMarkup(<RunArtifactEvidenceGrid report={makeReport()} />);

    expect(html).toContain("Executor Action Trace");
    expect(html).toContain("Verification Evidence");
    expect(html).toContain("Operational Follow-up");
    expect(html).toContain("read_file: Inspected persisted round summary formatting.");
    expect(html).toContain("bun test ./web/src/App.test.tsx");
    expect(html).toContain("Follow-up: Verify the run detail modal remains scannable.");
  });

  test("renders empty-state copy when no evidence items are present", () => {
    const html = renderToStaticMarkup(
      <RunArtifactEvidenceGrid
        report={makeReport({
          executorActionTrace: [],
          operationalEvidence: [],
          verificationEvidence: []
        })}
      />
    );

    expect(html).toContain("No executor action trace captured.");
    expect(html).toContain("No verification evidence captured.");
    expect(html).toContain("No operational evidence captured.");
  });
});
