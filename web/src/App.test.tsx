import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactCompletenessPanel,
  BudgetHealthPanel,
  ControlErrorPanel,
  CrashRecoveryPanel,
  HotFileGovernancePanel,
  LifecycleStatusGrid,
  OperatorReasonPanel,
  RunArtifactEvidenceGrid,
  SystemHealthPanel,
  deriveCliProvider,
  deriveControlAvailability,
  postControlAndRefresh,
  summarizeApiError
} from "./App";
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

describe("deriveCliProvider", () => {
  test("classifies claude binaries for the execution-provider toggle", () => {
    expect(deriveCliProvider("claude")).toBe("claude");
    expect(deriveCliProvider("/usr/local/bin/claude")).toBe("claude");
    expect(deriveCliProvider("codex")).toBe("codex");
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

describe("OperatorReasonPanel", () => {
  test("renders a prominent operator-facing pause reason with next action guidance", () => {
    const html = renderToStaticMarkup(
      <OperatorReasonPanel
        operatorReason={{
          kind: "budget_breach",
          title: "Budget breach",
          summary: "Paused because the action budget was exceeded (7 / 5).",
          next_action: "Review the last budget snapshot and reduce scope or raise budgets before resuming.",
          severity: "critical"
        }}
      />
    );

    expect(html).toContain("Pause / Risk Reason");
    expect(html).toContain("Budget breach");
    expect(html).toContain("Paused because the action budget was exceeded (7 / 5).");
    expect(html).toContain("Next Safe Action");
    expect(html).toContain("Review the last budget snapshot and reduce scope or raise budgets before resuming.");
  });

  test("renders a stable empty state when no pause or risk reason is active", () => {
    const html = renderToStaticMarkup(<OperatorReasonPanel operatorReason={null} />);

    expect(html).toContain("No active pause or risk signal");
    expect(html).toContain("The current status surface does not show a live pause or safety block.");
  });
});

describe("HotFileGovernancePanel", () => {
  test("renders a live status.hot_file_governance signal with the file path, reason, and next action", () => {
    const html = renderToStaticMarkup(
      <HotFileGovernancePanel
        signal={{
          file_path: "src/loop/engine.ts",
          heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
          result_class: "hot_file_growth_failure",
          reason: "continued growth in pressured file without bounded justification",
          recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
        }}
      />
    );

    expect(html).toContain("Hot-File Governance");
    expect(html).toContain("src/loop/engine.ts");
    expect(html).toContain("hot_file_growth_failure");
    expect(html).toContain("recent-touch hot-file pressure, line-count pressure");
    expect(html).toContain("continued growth in pressured file without bounded justification");
    expect(html).toContain("pause and split the next change into a bounded structural-maintenance pass");
  });

  test("renders nothing when no hot-file governance signal is present", () => {
    expect(renderToStaticMarkup(<HotFileGovernancePanel signal={null} />)).toBe("");
  });

  test("renders the run-history hot-file governance surface with the file path, reason, and next action", () => {
    const html = renderToStaticMarkup(
      <HotFileGovernancePanel
        signal={{
          file_path: "web/src/App.tsx",
          heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
          result_class: "hot_file_growth_failure",
          reason: "the evaluator blocked another inline governance change in the same file",
          recommended_next_action: "pause and split the next edit into a bounded follow-up"
        }}
        compact
      />
    );

    expect(html).toContain("Hot-File Governance");
    expect(html).toContain("web/src/App.tsx");
    expect(html).toContain("hot_file_growth_failure");
    expect(html).toContain("recent-touch hot-file pressure, line-count pressure");
    expect(html).toContain("the evaluator blocked another inline governance change in the same file");
    expect(html).toContain("pause and split the next edit into a bounded follow-up");
  });
});

describe("ArtifactCompletenessPanel", () => {
  test("renders the latest artifact completeness label and timestamp", () => {
    const html = renderToStaticMarkup(
      <ArtifactCompletenessPanel
        artifactCompleteness={{
          kind: "partial_bundle",
          label: "Partial bundle",
          latest_round_timestamp: "2026-03-15T02-16-09-241Z",
          latest_artifact_at: "2026-03-15T02:16:11.000Z",
          present: ["log", "summary", "metrics"],
          missing: ["state_change", "evaluation"]
        }}
      />
    );

    expect(html).toContain("Artifact Completeness");
    expect(html).toContain("Partial bundle");
    expect(html).toContain("Latest Artifact Timestamp");
    expect(html).toContain("2026");
    expect(html).toContain("Latest Round");
    expect(html).toContain("2026-03-15T02-16-09-241Z");
    expect(html).toContain("Missing: state change, evaluation");
  });

  test("renders the full-bundle state without missing artifact copy", () => {
    const html = renderToStaticMarkup(
      <ArtifactCompletenessPanel
        artifactCompleteness={{
          kind: "full_bundle",
          label: "Full evidence bundle",
          latest_round_timestamp: "2026-03-15T03-00-00-000Z",
          latest_artifact_at: "2026-03-15T03:00:05.000Z",
          present: ["log", "summary", "metrics", "state_change", "evaluation"],
          missing: []
        }}
      />
    );

    expect(html).toContain("Full evidence bundle");
    expect(html).toContain("All required evidence artifacts are present for the latest round.");
  });
});

describe("BudgetHealthPanel", () => {
  test("renders per-dimension health labels and the breached dimension from the persisted snapshot", () => {
    const html = renderToStaticMarkup(
      <BudgetHealthPanel
        budgetHealth={{
          overall: "breached",
          breached_dimension: "actions",
          dimensions: [
            {
              dimension: "cost",
              label: "USD",
              health: "warning",
              used: 0.9,
              limit: 1,
              ratio: 0.9
            },
            {
              dimension: "actions",
              label: "Actions",
              health: "breached",
              used: 11,
              limit: 10,
              ratio: 1.1
            },
            {
              dimension: "time",
              label: "Time",
              health: "healthy",
              used: 30_000,
              limit: 120_000,
              ratio: 0.25
            }
          ]
        }}
        currentBudget={{
          limits: {
            usdPerRound: 1,
            timeMinutes: 2,
            actions: 10
          },
          usage: {
            usdUsed: 0.9,
            elapsedMs: 30_000,
            actionsUsed: 11
          }
        }}
      />
    );

    expect(html).toContain("Budget Health");
    expect(html).toContain("Breached Dimension: Actions");
    expect(html).toContain("USD health: warning");
    expect(html).toContain("Actions health: breached");
    expect(html).toContain("Time health: healthy");
    expect(html).toContain("0.9000 / 1");
    expect(html).toContain("11 / 10");
    expect(html).toContain("30s / 2m");
  });
});

describe("SystemHealthPanel", () => {
  test("renders recent hot-file pressure alongside the existing friction metrics", () => {
    const html = renderToStaticMarkup(
      <SystemHealthPanel
        frictionIndex={{
          reworkChurnRate: 0.15,
          averageActions: 18.2,
          leaderInterventionCount: 1,
          overEngineeringCount: 0,
          hotFilePressureCount: 2,
          healthStatus: "at_risk"
        }}
      />
    );

    expect(html).toContain("System Health (Friction Index)");
    expect(html).toContain("Recent telemetry from the last 20 rounds.");
    expect(html).toContain("Hot-File Pressure");
    expect(html).toContain("governance blocks");
    expect(html).toContain(">2<");
    expect(html).toContain("Interventions");
  });

  test("renders nothing when friction telemetry is unavailable", () => {
    expect(renderToStaticMarkup(<SystemHealthPanel frictionIndex={null} />)).toBe("");
  });
});

describe("LifecycleStatusGrid", () => {
  test("renders the queued operator instruction count and active pause reason alongside the lifecycle status cards", () => {
    const html = renderToStaticMarkup(
      <LifecycleStatusGrid
        status={{
          state: "paused",
          round: 12,
          pid: 4312,
          pid_alive: true,
          pending_instruction_count: 4,
          pause_reason: "Budget breach",
          crash_recovery: null,
          operator_reason: null,
          artifact_completeness: {
            kind: "none",
            label: "No artifacts yet",
            latest_round_timestamp: null,
            latest_artifact_at: null,
            present: [],
            missing: ["log", "summary", "metrics", "state_change", "evaluation"]
          },
          last_error: null,
          updated_at: "2026-03-15T03:12:00.000Z",
          consecutive_evaluator_failures: 1,
          budget_health: null,
          current_budget: null,
          active_requirement: {
            path: "",
            exists: false,
            artifact_status: "missing",
            lifecycle_status: "active",
            title: null,
            summary: null,
            acceptance_criteria_total: 0,
            acceptance_criteria_completed: 0,
            markdown: null,
            updated_at: null
          }
        }}
      />
    );

    expect(html).toContain("Pending instructions");
    expect(html).toContain("4 queued");
    expect(html).toContain("Pause reason: Budget breach");
    expect(html).toContain("Round: 12");
    expect(html).toContain("PID: 4312");
  });

  test("renders cleared pause metadata as none active after a paused run resumes", () => {
    const html = renderToStaticMarkup(
      <LifecycleStatusGrid
        status={{
          state: "running",
          round: 13,
          pid: 4312,
          pid_alive: true,
          pending_instruction_count: 0,
          pause_reason: null,
          crash_recovery: null,
          operator_reason: null,
          artifact_completeness: {
            kind: "none",
            label: "No artifacts yet",
            latest_round_timestamp: null,
            latest_artifact_at: null,
            present: [],
            missing: ["log", "summary", "metrics", "state_change", "evaluation"]
          },
          last_error: null,
          updated_at: "2026-03-15T03:20:00.000Z",
          consecutive_evaluator_failures: 0,
          budget_health: null,
          current_budget: null,
          active_requirement: {
            path: "",
            exists: false,
            artifact_status: "missing",
            lifecycle_status: "active",
            title: null,
            summary: null,
            acceptance_criteria_total: 0,
            acceptance_criteria_completed: 0,
            markdown: null,
            updated_at: null
          }
        }}
      />
    );

    expect(html).toContain("Pause reason: None active");
    expect(html).toContain("Process: alive");
    expect(html).toContain("Pending instructions: 0 queued");
  });
});

describe("deriveControlAvailability", () => {
  test("matches the persisted lifecycle contract for operator controls", () => {
    expect(deriveControlAvailability("starting")).toEqual({
      canStart: false,
      canPause: true,
      canResume: false,
      canStop: true
    });

    expect(deriveControlAvailability("paused")).toEqual({
      canStart: false,
      canPause: false,
      canResume: true,
      canStop: true
    });

    expect(deriveControlAvailability("idle")).toEqual({
      canStart: true,
      canPause: false,
      canResume: false,
      canStop: false
    });
  });
});

describe("ControlErrorPanel", () => {
  test("surfaces rejected lifecycle controls with the persisted state context", () => {
    const html = renderToStaticMarkup(
      <ControlErrorPanel
        message="Invalid control transition: resume is only allowed from paused."
        state="running"
      />
    );

    expect(html).toContain("Control rejected");
    expect(html).toContain("Invalid control transition: resume is only allowed from paused.");
    expect(html).toContain("Persisted state: running");
    expect(html).toContain("The request did not mutate the backend lifecycle state.");
  });
});

describe("postControlAndRefresh", () => {
  test("refreshes persisted status after a rejected lifecycle control before rethrowing", async () => {
    const calls: string[] = [];

    await expect(
      postControlAndRefresh(
        async () => {
          calls.push("request");
          throw new Error("Invalid control transition: pause is only allowed from starting, running, or cooldown.");
        },
        async () => {
          calls.push("refresh");
        }
      )
    ).rejects.toThrow("Invalid control transition: pause is only allowed from starting, running, or cooldown.");

    expect(calls).toEqual(["request", "refresh"]);
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
