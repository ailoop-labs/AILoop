import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AiRuntimePanel,
  ArtifactCompletenessPanel,
  BudgetHealthPanel,
  ControlErrorPanel,
  CrashRecoveryPanel,
  FailureDiagnosticsPanel,
  HotFileGovernancePanel,
  LifecycleStatusGrid,
  OperatorReasonPanel,
  RunArtifactEvidenceGrid,
  RunHistoryCard,
  SystemHealthPanel,
  applyCliProvider,
  deriveCliProvider,
  deriveControlAvailability,
  getCliModelOptions,
  parseFailureDiagnostics,
  resolveCliModel,
  postControlAndRefresh,
  summarizeApiError
} from "./App";
import type { RoundReport, RunHistoryItem } from "./run-history";

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

function makeRunHistoryItem(overrides: Partial<RunHistoryItem> = {}): RunHistoryItem {
  return {
    timestamp: "2026-03-15T03-00-00.000Z",
    round: 12,
    summary: [
      "- Objective: Keep run-history governance signals scannable",
      "- Expected Outcome: Operators can distinguish hot-file governance from ordinary failures",
      "- Tool Status: success",
      "- Work Summary: Added a first-line governance callout to recent history cards",
      "- Error: none",
      "- Decision: fail",
      "- Justification: The round remained blocked by hot-file governance",
      "- Root Cause: pressured file growth",
      "- Evidence: bun test ./web/src/App.test.tsx",
      "- Cost USD: 0.02",
      "- Time ms: 2200",
      "- Actions: 3",
      "",
      "## Next Round Recommendation",
      "Split the next change into a bounded follow-up."
    ].join("\n"),
    metrics: {},
    evaluation: {
      decision: "fail",
      justification: "The evaluator blocked more growth in a pressured file.",
      root_cause: "pressured file growth",
      evidence: ["bun test ./web/src/App.test.tsx"],
      aggregate_score: 71,
      recommended_next_action: "Split the next change into a bounded follow-up.",
      hot_file_governance: {
        file_path: "web/src/App.tsx",
        heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
        result_class: "hot_file_growth_failure",
        reason: "continued growth in pressured file without bounded justification",
        recommended_next_action: "pause and split the next edit into a bounded follow-up"
      }
    },
    artifacts: {
      kind: "full_bundle",
      label: "Full evidence bundle",
      present: ["log", "summary", "metrics", "state_change", "evaluation"],
      missing: []
    },
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

describe("CLI provider/model helpers", () => {
  test("returns codex-specific model options for the codex provider", () => {
    expect(getCliModelOptions("codex").map((option) => option.value)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
  });

  test("falls back to the provider default model when the saved model belongs to another provider", () => {
    expect(resolveCliModel("codex", "claude-opus-4-6")).toBe("gpt-5.4");
    expect(resolveCliModel("claude", "gpt-5.4")).toBe("claude-opus-4-6");
  });

  test("switching providers updates both the bin and the CLI model", () => {
    const next = applyCliProvider(
      {
        intervalSeconds: 30,
        maxCycles: 0,
        exitOnError: false,
        budget: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        ai: {
          bin: "claude",
          model: "claude-sonnet-4-6",
          profile: "",
          plannerSandbox: "read-only",
          executorSandbox: "workspace-write",
          evaluatorSandbox: "workspace-write"
        },
        codex: {
          bin: "claude",
          model: "claude-sonnet-4-6",
          profile: "",
          plannerSandbox: "read-only",
          executorSandbox: "workspace-write",
          evaluatorSandbox: "workspace-write"
        }
      },
      "codex"
    );

    expect(next.ai.bin).toBe("codex");
    expect(next.codex.bin).toBe("codex");
    expect(next.ai.model).toBe("gpt-5.4");
    expect(next.codex.model).toBe("gpt-5.4");
  });
});

describe("AiRuntimePanel", () => {
  test("renders the actual execution route and a Claude routing warning", () => {
    const html = renderToStaticMarkup(
      <AiRuntimePanel
        runtimeConfig={{
          intervalSeconds: 60,
          maxCycles: 0,
          exitOnError: false,
          budget: {
            usdPerRound: 0.5,
            timeMinutes: 60,
            actions: 10
          },
          ai: {
            bin: "claude",
            model: "claude-opus-4-6",
            profile: "",
            plannerSandbox: "read-only",
            executorSandbox: "danger-full-access",
            evaluatorSandbox: "danger-full-access"
          },
          codex: {
            bin: "claude",
            model: "claude-opus-4-6",
            profile: "",
            plannerSandbox: "read-only",
            executorSandbox: "danger-full-access",
            evaluatorSandbox: "danger-full-access"
          },
          aiRuntime: {
            bin: "/opt/homebrew/bin/claude",
            provider: "claude",
            claudeSettingsPath: "/Users/test/.claude/settings.json",
            claudeBaseUrlOverride: "https://api.minimaxi.com/anthropic",
            claudeModelOverride: "MiniMax-M2.7",
            warning:
              "Claude CLI on this machine is routed through https://api.minimaxi.com/anthropic via /Users/test/.claude/settings.json; selecting Claude here will consume that provider's quota."
          }
        }}
      />
    );

    expect(html).toContain("Actual Execution Route");
    expect(html).toContain("/opt/homebrew/bin/claude");
    expect(html).toContain("https://api.minimaxi.com/anthropic");
    expect(html).toContain("will consume that provider&#x27;s quota");
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

  test("preserves the distinct strategic evaluator block title, summary, and next action", () => {
    const html = renderToStaticMarkup(
      <OperatorReasonPanel
        operatorReason={{
          kind: "evaluator_strategic_block",
          title: "Strategic evaluator block",
          summary: "Further retries require immediate governance review.",
          next_action: "Review the evaluator findings, adjust scope, and resume only after the governance issue is addressed.",
          severity: "critical"
        }}
      />
    );

    expect(html).toContain("Pause / Risk Reason");
    expect(html).toContain("Strategic evaluator block");
    expect(html).toContain("Further retries require immediate governance review.");
    expect(html).toContain("Next Safe Action");
    expect(html).toContain("Review the evaluator findings, adjust scope, and resume only after the governance issue is addressed.");
  });

  test("renders a stable empty state when no pause or risk reason is active", () => {
    const html = renderToStaticMarkup(<OperatorReasonPanel operatorReason={null} />);

    expect(html).toContain("No active pause or risk signal");
    expect(html).toContain("The current status surface does not show a live pause or safety block.");
  });
});

describe("Failure diagnostics", () => {
  test("extracts a provider rate-limit signal and diagnostics artifact from persisted last_error text", () => {
    const diagnostics = parseFailureDiagnostics(
      'Governance failed due to provider/network error: AI CLI exited with code 1 | detail: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}} | diagnostics: /tmp/leader.debug.json'
    );

    expect(diagnostics.summary).toBe("Governance failed due to provider/network error: AI CLI exited with code 1");
    expect(diagnostics.providerSignal?.kind).toBe("provider_rate_limit");
    expect(diagnostics.providerSignal?.label).toBe("Provider rate limit");
    expect(diagnostics.providerSignal?.detail).toContain("usage limit exceeded");
    expect(diagnostics.diagnosticsPath).toBe("/tmp/leader.debug.json");
  });

  test("renders a sectioned diagnostics panel with summary, provider signal, and artifact path", () => {
    const html = renderToStaticMarkup(
      <FailureDiagnosticsPanel
        message={
          'Planner AI CLI rate-limited: AI CLI exited with code 1 | stderr: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}} | diagnostics: /tmp/planner.debug.json'
        }
      />
    );

    expect(html).toContain("Failure Diagnostics");
    expect(html).toContain("Planner AI CLI rate-limited: AI CLI exited with code 1");
    expect(html).toContain("Provider Condition");
    expect(html).toContain("Provider rate limit");
    expect(html).toContain("usage limit exceeded");
    expect(html).toContain("Diagnostics Artifact");
    expect(html).toContain("/tmp/planner.debug.json");
  });

  test("renders stable empty-state copy when the error has no provider marker or diagnostics path", () => {
    const html = renderToStaticMarkup(<FailureDiagnosticsPanel message="Evaluator blocked the round." />);

    expect(html).toContain("Last recorded failure");
    expect(html).toContain("Evaluator blocked the round.");
    expect(html).toContain("No provider-specific condition detected in the persisted failure text.");
    expect(html).toContain("No diagnostics artifact path was attached to the last error.");
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

describe("RunHistoryCard", () => {
  test("renders a first-line hot-file governance indicator with compact file, class, and reason context", () => {
    const html = renderToStaticMarkup(
      <RunHistoryCard
        run={makeRunHistoryItem()}
        index={0}
        startIndex={0}
        onOpenArtifacts={() => {}}
      />
    );

    expect(html).toContain("Hot-File Governance");
    expect(html).toContain("File: web/src/App.tsx");
    expect(html).toContain("Class: hot_file_growth_failure");
    expect(html).toContain("Reason: continued growth in pressured file without bounded justification");
    expect(html).toContain("Evaluator fail");
    expect(html.indexOf("Hot-File Governance")).toBeLessThan(html.indexOf("Evaluator fail"));
    expect(html.indexOf("Hot-File Governance")).toBeLessThan(html.indexOf("Objective:"));
  });

  test("falls back to the persisted run-level hot-file governance signal when evaluation details are absent", () => {
    const html = renderToStaticMarkup(
      <RunHistoryCard
        run={makeRunHistoryItem({
          evaluation: {
            ...makeRunHistoryItem().evaluation!,
            hot_file_governance: null
          },
          hot_file_governance: {
            file_path: "src/loop/control.ts",
            heuristic_labels: ["recent-touch hot-file pressure"],
            result_class: "hot_file_growth_failure",
            reason: "paused history kept the governance signal after evaluation details were trimmed",
            recommended_next_action: "review the paused run and split the next edit into a bounded follow-up"
          }
        })}
        index={0}
        startIndex={0}
        onOpenArtifacts={() => {}}
      />
    );

    expect(html).toContain("Hot-File Governance");
    expect(html).toContain("File: src/loop/control.ts");
    expect(html).toContain("Reason: paused history kept the governance signal after evaluation details were trimmed");
    expect(html).toContain("review the paused run and split the next edit into a bounded follow-up");
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
          hot_file_governance: null,
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
          hot_file_governance: null,
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
