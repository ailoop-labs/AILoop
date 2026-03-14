import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CrashRecoveryPanel, RunArtifactEvidenceGrid, summarizeApiError } from "./App";
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
    materialStateChange: [
      "Files changed: src/reporting/summary.ts, web/src/App.tsx",
      "Added lines: 4"
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
    expect(html).toContain("Material State Change");
    expect(html).toContain("Verification Evidence");
    expect(html).toContain("Operational Follow-up");
    expect(html).toContain("read_file: Inspected persisted round summary formatting.");
    expect(html).toContain("Files changed: src/reporting/summary.ts, web/src/App.tsx");
    expect(html).toContain("bun test ./web/src/App.test.tsx");
    expect(html).toContain("Follow-up: Verify the run detail modal remains scannable.");
  });

  test("renders empty-state copy when no evidence items are present", () => {
    const html = renderToStaticMarkup(
      <RunArtifactEvidenceGrid
        report={makeReport({
          executorActionTrace: [],
          materialStateChange: [],
          operationalEvidence: [],
          verificationEvidence: []
        })}
      />
    );

    expect(html).toContain("No executor action trace captured.");
    expect(html).toContain("No material state change summary captured.");
    expect(html).toContain("No verification evidence captured.");
    expect(html).toContain("No operational evidence captured.");
  });
});

describe("CrashRecoveryPanel", () => {
  test("renders distinct recovery signals for a startup interruption", () => {
    const html = renderToStaticMarkup(
      <CrashRecoveryPanel
        crashRecovery={{
          interruption_type: "startup_interrupted",
          interrupted_state: "starting",
          recovered_by: "status_check",
          status_check_finalized: true,
          normal_round_execution_started: false,
          incomplete_work: false,
          reason: "process 999999 was not alive",
          summary: "Initialization was interrupted before normal round execution began.",
          next_action: "Inspect the run state and resume explicitly when safe."
        }}
      />
    );

    expect(html).toContain("Crash Recovery");
    expect(html).toContain("Startup interrupted");
    expect(html).toContain("Initialization was interrupted before normal round execution began.");
    expect(html).toContain("Finalized during status check");
    expect(html).toContain("No incomplete round work detected");
    expect(html).toContain("Inspect the run state and resume explicitly when safe.");
  });

  test("renders nothing when no recovery status is present", () => {
    expect(renderToStaticMarkup(<CrashRecoveryPanel crashRecovery={null} />)).toBe("");
  });
});

describe("summarizeApiError", () => {
  test("reduces HTML server error bodies to a compact operator-readable message", () => {
    const htmlError = [
      "<html>",
      "<head><title>500 Internal Server Error</title></head>",
      "<body><h1>Internal Server Error</h1><pre>SQLiteError: disk I/O error</pre></body>",
      "</html>"
    ].join("");

    expect(summarizeApiError(500, htmlError, "text/html")).toBe(
      "Server error (500). The console returned an HTML error page instead of JSON."
    );
  });
});
