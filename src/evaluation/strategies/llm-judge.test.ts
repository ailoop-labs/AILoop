import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../config/env";
import type { DimensionAssessment, RoundEvaluationContext } from "../../types/contracts";
import { LLMJudgeEvaluator, aggregateDimensionAssessments, buildDimensionPrompt } from "./llm-judge";

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

function makeRoundContext(): RoundEvaluationContext {
  return {
    subTask: {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Update workspace snapshot handling",
      expected_outcome: "workspace snapshot tests pass",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    },
    toolResult: {
      status: "success",
      summary: "updated workspace snapshot",
      artifacts: {
        state_change_path: ".ailoop/runs/example.round.state_change.txt",
        log_path: ".ailoop/runs/example.round.log"
      },
      error: undefined,
      next_state_hint: "continue"
    },
    stateChange: "diff --git a/src/environment/workspace.ts b/src/environment/workspace.ts",
    logLines: ["executor started", "executor finished"],
    runTimestamp: "2026-03-01T00:00:00.000Z",
    budgetLimits: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    budgetUsage: {
      usdUsed: 0.05,
      actionsUsed: 5,
      elapsedMs: 5000
    },
    onLog: async () => {}
  };
}

function makeLlmConfig(dimensions: AppConfig["codex"]["llmEvaluatorDimensions"] = ["goal_alignment"]): AppConfig {
  const aiConfig = {
    bin: "codex",
    model: "",
    profile: "",
    plannerSandbox: "read-only",
    executorSandbox: "workspace-write",
    evaluatorSandbox: "workspace-write",
    timeoutMs: 30_000,
    llmEvaluatorDimensions: dimensions,
    llmEvaluatorMinPassScore: 70
  };

  return {
    homeDir: "/tmp/ailoop-test",
    intervalSeconds: 1,
    maxCycles: 1,
    exitOnError: false,
    evaluatorReworkMaxAttempts: 1,
    consoleHost: "127.0.0.1",
    consolePort: 3090,
    consoleAdminToken: "",
    maxRetainRuns: 10,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    ai: aiConfig,
    codex: aiConfig // Backward compatibility
  };
}

function extractPromptRoundContext(prompt: string): Record<string, unknown> {
  const marker = "Round context:\n";
  const start = prompt.indexOf(marker);
  if (start < 0) {
    throw new Error("Round context marker not found in prompt.");
  }

  return JSON.parse(prompt.slice(start + marker.length)) as Record<string, unknown>;
}

describe("buildDimensionPrompt", () => {
  test("adds runtime isolation guidance for evaluator sessions", () => {
    const prompt = buildDimensionPrompt(
      "constraint_compliance",
      makeRoundContext(),
      "# Evaluator Role\n\nProject-specific evaluator guidance."
    );

    expect(prompt).toContain("Project-specific Evaluator Role Definition");
    expect(prompt).toContain("Project-specific evaluator guidance.");
    expect(prompt).toContain("This internal runtime session is intentionally isolated");
    expect(prompt).toContain("Do not inspect repository files");
    expect(prompt).toContain("use external development-assistant skills");
  });
});

describe("aggregateDimensionAssessments", () => {
  test("fails immediately when constraint_compliance fails", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 90 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 20,
          justification: "Secret leakage detected in round artifacts.",
          evidence: ["Artifact log contains an unredacted API token."],
          blocking_issues: ["policy violation"],
          recommended_next_action: "rotate exposed token and redact stored artifacts"
        }),
        makeAssessment({ dimension: "risk_externality", score: 85 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Hard gate");
    expect(result.evidence.some((line) => line.includes("constraint_compliance detail:"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("unredacted API token"))).toBe(true);
    expect(result.recommended_next_action).toContain("rotate exposed token and redact stored artifacts");
  });

  test("fails with pause recommendation when key dimension is unknown", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({
          dimension: "goal_alignment",
          decision: "unknown",
          score: 0,
          justification: "No before/after KPI comparison was attached to the round.",
          evidence: ["State change artifact shows file edits only; no KPI output was logged."],
          recommended_next_action: "collect KPI evidence"
        }),
        makeAssessment({ dimension: "causal_validity", score: 78 }),
        makeAssessment({ dimension: "constraint_compliance", score: 92 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Insufficient evidence");
    expect(result.evidence.some((line) => line.includes("goal_alignment detail:"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("no KPI output was logged"))).toBe(true);
    expect(result.recommended_next_action).toContain("goal_alignment: collect KPI evidence");
    expect(result.recommended_next_action).toContain("pause");
    expect(result.recovery_path).toBe("strategic_governance");
  });

  test("surfaces Codex authentication failures as evaluator infrastructure blockers", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({
          dimension: "goal_alignment",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: [
            "Codex exited with code 1",
            "Error: 401 Unauthorized - incorrect API key provided while calling the evaluator model."
          ],
          recommended_next_action: "pause and inspect evaluator failure"
        }),
        makeAssessment({ dimension: "causal_validity", score: 81 }),
        makeAssessment({ dimension: "constraint_compliance", score: 90 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Evaluator infrastructure failure");
    expect(result.justification).toContain("Codex authentication failed");
    expect(result.root_cause).toBe("evaluator_infrastructure:codex_authentication");
    expect(result.evidence.some((line) => line.includes("401 Unauthorized"))).toBe(true);
    expect(result.recommended_next_action).toContain(".ailoop/codex-home/auth.json");
    expect(result.recommended_next_action).not.toContain("gather evidence");
    expect(result.recovery_path).toBe("strategic_governance");
  });

  test("surfaces generic Codex process failures as evaluator infrastructure blockers", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({
          dimension: "goal_alignment",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: [
            "Codex exited with code 1",
            "Evaluator prompt likely exceeded practical size after embedding a very large state-change body."
          ],
          recommended_next_action: "pause and inspect evaluator failure"
        }),
        makeAssessment({
          dimension: "causal_validity",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: ["Codex exited with code 1"],
          recommended_next_action: "pause and inspect evaluator failure"
        }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: ["Codex exited with code 1"],
          recommended_next_action: "pause and inspect evaluator failure"
        })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Evaluator infrastructure failure");
    expect(result.root_cause).toBe("evaluator_infrastructure:codex_process_failure");
    expect(result.recommended_next_action).toContain("prompt");
    expect(result.recovery_path).toBe("strategic_governance");
  });

  test("surfaces provider credit and token-limit failures as evaluator infrastructure blockers", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({
          dimension: "goal_alignment",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: [
            "AI CLI exited with code 1",
            "API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 44565."
          ],
          recommended_next_action: "pause and inspect evaluator failure"
        }),
        makeAssessment({
          dimension: "causal_validity",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: ["AI CLI exited with code 1"],
          recommended_next_action: "pause and inspect evaluator failure"
        }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "unknown",
          score: 0,
          confidence: 0,
          justification: "Dimension evaluator call failed.",
          evidence: ["AI CLI exited with code 1"],
          recommended_next_action: "pause and inspect evaluator failure"
        })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Evaluator infrastructure failure");
    expect(result.root_cause).toBe("evaluator_infrastructure:provider_quota");
    expect(result.evidence.some((line) => line.includes("more credits"))).toBe(true);
    expect(result.recommended_next_action).toContain("credits");
    expect(result.recommended_next_action).toContain("max_tokens");
    expect(result.recovery_path).toBe("strategic_governance");
  });

  test("surfaces concrete evidence and follow-up actions when a key dimension fails", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 88 }),
        makeAssessment({
          dimension: "causal_validity",
          decision: "fail",
          score: 35,
          justification: "The claimed impact is not supported by observed command output.",
          evidence: ["No test or metric output demonstrates the claimed behavior change."],
          recommended_next_action: "rerun targeted verification with before and after output"
        }),
        makeAssessment({ dimension: "constraint_compliance", score: 93 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("causal_validity");
    expect(result.evidence.some((line) => line.includes("causal_validity detail:"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("No test or metric output demonstrates"))).toBe(true);
    expect(result.recommended_next_action).toContain(
      "causal_validity: rerun targeted verification with before and after output"
    );
    expect(result.recovery_path).toBe("tactical_rework");
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

  test("treats scope-only file-range overflow as non-blocking signal", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 92 }),
        makeAssessment({ dimension: "causal_validity", score: 88 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 20,
          justification: "Unrelated file mutations indicate hidden scope expansion beyond the declared sub-task.",
          blocking_issues: ["Unrelated file mutations indicate hidden scope expansion beyond the declared sub-task."]
        }),
        makeAssessment({ dimension: "risk_externality", score: 84 }),
        makeAssessment({ dimension: "reversibility_resilience", score: 81 }),
        makeAssessment({ dimension: "learning_yield", score: 76 })
      ],
      75
    );

    expect(result.decision).toBe("pass");
    expect(result.justification).not.toContain("Hard gate");
    expect(result.recommended_next_action).toBe("continue");
  });

  test("keeps hard gate failure for concrete policy violations", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 90 }),
        makeAssessment({ dimension: "causal_validity", score: 85 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 15,
          justification: "Policy violation: secret token was logged in clear text.",
          blocking_issues: ["Policy violation: secret token exposed in artifacts."]
        }),
        makeAssessment({ dimension: "risk_externality", score: 83 })
      ],
      75
    );

    expect(result.decision).toBe("fail");
    expect(result.justification).toContain("Hard gate");
    expect(result.recommended_next_action).toContain("Policy violation");
  });

  test("redacts secret-like values before surfacing detailed evidence and follow-up actions", () => {
    const leakedApiKey = "sk-live-12345";
    const leakedSessionSecret = "super-secret-value";
    const leakedGithubToken = "ghp_secret_67890";

    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", score: 91 }),
        makeAssessment({
          dimension: "constraint_compliance",
          decision: "fail",
          score: 5,
          justification: `Policy violation: OPENAI_API_KEY=${leakedApiKey} was written to evaluator output.`,
          evidence: [
            `artifact excerpt: SESSION_SECRET=${leakedSessionSecret}`,
            `log excerpt: GITHUB_TOKEN=${leakedGithubToken}`
          ],
          blocking_issues: [`rotate OPENAI_API_KEY=${leakedApiKey} and purge exposed logs`],
          recommended_next_action: `rotate SESSION_SECRET=${leakedSessionSecret} and GITHUB_TOKEN=${leakedGithubToken}`
        })
      ],
      75
    );

    const serialized = [result.justification, ...result.evidence, result.recommended_next_action].join("\n");

    expect(serialized).not.toContain(leakedApiKey);
    expect(serialized).not.toContain(leakedSessionSecret);
    expect(serialized).not.toContain(leakedGithubToken);
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(serialized).toContain("SESSION_SECRET=[REDACTED]");
    expect(serialized).toContain("GITHUB_TOKEN=[REDACTED]");
  });

  test("normalizes scores from 0-1 scale to 0-100 when all scores are low and at least one passed", () => {
    const result = aggregateDimensionAssessments(
      [
        makeAssessment({ dimension: "goal_alignment", decision: "pass", score: 1.0 }),
        makeAssessment({ dimension: "causal_validity", decision: "pass", score: 0.9 }),
        makeAssessment({ dimension: "constraint_compliance", decision: "pass", score: 0.95 })
      ],
      75
    );

    expect(result.decision).toBe("pass");
    expect(result.aggregateScore).toBeGreaterThanOrEqual(90);
    expect(result.evidence.some(e => e.includes("score=100.0"))).toBe(true);
    expect(result.evidence.some(e => e.includes("score=90.0"))).toBe(true);
  });
});

describe("LLMJudgeEvaluator", () => {
  test("runs dimension checks in an isolated runtime session", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-evaluator-agent-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "# Evaluator Role\n\nCustom evaluator guidance.\n", "utf8");

    let capturedPrompt = "";
    let capturedCwd = "";
    let capturedIsolationEnabled = false;
    let capturedIsolationGuide = "";
    const mockCodex = {
      async runJson<T>(options?: {
        prompt?: string;
        cwd?: string;
        sessionIsolation?: {
          enabled?: boolean;
          agentsGuide?: string;
        };
      }) {
        capturedPrompt = options?.prompt ?? "";
        capturedCwd = options?.cwd ?? "";
        capturedIsolationEnabled = options?.sessionIsolation?.enabled === true;
        capturedIsolationGuide = options?.sessionIsolation?.agentsGuide ?? "";
        return {
          ok: true,
          data: {
            dimension: "constraint_compliance",
            decision: "pass",
            score: 90,
            confidence: 0.8,
            justification: "Evidence is sufficient.",
            evidence: ["round context is self-consistent"],
            blocking_issues: [],
            recommended_next_action: "continue"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const realWorkspaceRoot = await fs.realpath(process.cwd());
      const config = {
        ...makeLlmConfig(["constraint_compliance"]),
        homeDir
      };
      const evaluator = new LLMJudgeEvaluator(config, mockCodex as never);
      const result = await evaluator.evaluate(makeRoundContext());

      expect(result.decision).toBe("pass");
      expect(capturedPrompt).toContain("Custom evaluator guidance.");
      expect(capturedIsolationEnabled).toBe(true);
      expect(capturedIsolationGuide).toContain("Internal Runtime Agent Session");
      expect(capturedIsolationGuide).toContain("Judge only from the provided prompt context");
      expect(capturedCwd).toBe(realWorkspaceRoot);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("emits structured hot-file governance metadata when pressured-file growth is the blocking failure", async () => {
    const mockCodex = {
      async runJson<T>() {
        return {
          ok: true,
          data: {
            dimension: "constraint_compliance",
            decision: "fail",
            score: 20,
            confidence: 0.92,
            justification:
              "recent-touch hot-file pressure in `src/loop/engine.ts`: continued growth in pressured file without bounded justification",
            evidence: [
              "Heuristic labels: recent-touch hot-file pressure, line-count pressure",
              "The round kept adding lines to `src/loop/engine.ts` instead of issuing a bounded structural-maintenance round."
            ],
            blocking_issues: [
              "Structural-governance blockage: continued growth in pressured file without bounded justification"
            ],
            recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const evaluator = new LLMJudgeEvaluator(makeLlmConfig(["constraint_compliance"]), mockCodex as never);
    const result = await evaluator.evaluate(makeRoundContext());

    expect(result.decision).toBe("fail");
    expect(result.hot_file_governance).toEqual({
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
      result_class: "hot_file_growth_failure",
      reason: "recent-touch hot-file pressure in `src/loop/engine.ts`: continued growth in pressured file without bounded justification",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    });
  });

  test("does not mislabel ordinary evaluator failures as hot-file governance", async () => {
    const mockCodex = {
      async runJson<T>() {
        return {
          ok: true,
          data: {
            dimension: "constraint_compliance",
            decision: "fail",
            score: 35,
            confidence: 0.87,
            justification: "Targeted verification evidence is missing for the claimed API behavior change.",
            evidence: ["No test command or runtime check was recorded for the changed endpoint."],
            blocking_issues: ["Add a focused verification command before claiming the fix worked."],
            recommended_next_action: "run the narrowest missing verification and attach the result"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const evaluator = new LLMJudgeEvaluator(makeLlmConfig(["constraint_compliance"]), mockCodex as never);
    const result = await evaluator.evaluate(makeRoundContext());

    expect(result.decision).toBe("fail");
    expect(result.hot_file_governance).toBeNull();
  });
});

describe("buildDimensionPrompt", () => {
  test("includes scope-only vs concrete-risk decision examples for hard-gate dimensions", () => {
    const context = makeRoundContext();
    const prompt = buildDimensionPrompt("constraint_compliance", context);

    expect(prompt).toContain("Decision examples");
    expect(prompt).toContain("scope-only");
    expect(prompt).toContain("policy/budget/safety");
    expect(prompt).toContain("Evidence priority");
    expect(prompt).toContain("behavioral verification");
    expect(prompt).toContain("structural scope signal");
  });

  test("injects project-specific evaluator role definition block", () => {
    const context = makeRoundContext();
    const prompt = buildDimensionPrompt(
      "goal_alignment",
      context,
      "# Evaluator Role\n\nProject-specific evaluator instructions."
    );

    expect(prompt).toContain("Project-specific Evaluator Role Definition");
    expect(prompt).toContain("Project-specific evaluator instructions.");
  });

  test("uses a compact evidence brief instead of embedding the full raw state change", () => {
    const context = makeRoundContext();
    context.toolResult.operational_evidence = [
      "Test: bun test src/evaluation/strategies/llm-judge.test.ts -> 12 passed",
      "Assertion: prompt contains validation_summary and targeted_excerpts"
    ];
    context.stateChange = [
      "### Snapshot File Diffs",
      "```diff",
      "--- .ailoop/runs/example.round.log",
      "+++ .ailoop/runs/example.round.log",
      "@@ -1 +1,2000 @@",
      "+very large log body line 1",
      "+very large log body line 2",
      "```",
      "",
      "### Git Untracked Delta",
      "```diff",
      "+++ src/loop/engine.state-json-contract.test.ts",
      "```"
    ].join("\n");
    context.logLines = Array.from({ length: 60 }, (_, index) => `log line ${index + 1}`);

    const prompt = buildDimensionPrompt("goal_alignment", context);
    const roundContext = extractPromptRoundContext(prompt);

    expect(prompt).toContain("\"artifact_manifest\"");
    expect(prompt).toContain("\"state_change_summary\"");
    expect(prompt).toContain("src/loop/engine.state-json-contract.test.ts");
    expect(prompt).not.toContain("very large log body line 1");
    expect(prompt).not.toContain("\"state_change\":");
    expect(prompt).not.toContain("log line 21");
    expect(prompt).not.toContain("log line 60");
    expect(roundContext).toHaveProperty("executor_summary");
    expect(roundContext).toHaveProperty("validation_summary");
    expect(roundContext).toHaveProperty("targeted_excerpts");
    expect(roundContext).not.toHaveProperty("recent_logs");
  });

  test("includes a distinct validation summary and reasoned targeted excerpts", () => {
    const context = makeRoundContext();
    context.toolResult.operational_evidence = [
      "Test: bun test src/evaluation/strategies/llm-judge.test.ts -> 12 passed",
      "Health Check: GET /api/health -> 200 OK"
    ];
    context.stateChange = [
      "### Operational Follow-up",
      "### Snapshot File Diffs",
      "```diff",
      "+++ src/evaluation/strategies/llm-judge.ts",
      "```"
    ].join("\n");
    context.logLines = [
      "executor started",
      "validation: targeted prompt excerpt selected from log",
      "executor finished"
    ];

    const roundContext = extractPromptRoundContext(buildDimensionPrompt("goal_alignment", context));
    const validationSummary = roundContext.validation_summary as Record<string, unknown>;
    const targetedExcerpts = roundContext.targeted_excerpts as Array<Record<string, string>>;

    expect(validationSummary.status).toBe("recorded");
    expect(String(validationSummary.summary)).toContain("Executor recorded 2 concise validation signal");
    expect(validationSummary.primary_sources).toEqual(["tool_result.operational_evidence"]);
    expect(targetedExcerpts.length).toBeGreaterThan(0);
    expect(targetedExcerpts[0]?.source).toBe("tool_result.operational_evidence");
    expect(targetedExcerpts[0]?.selection_reason).toContain("shortest direct verification claim");
    expect(targetedExcerpts[0]?.artifact_path).toBe(".ailoop/runs/example.round.state_change.txt");
    expect(targetedExcerpts.some((excerpt) => excerpt.source === "log_lines")).toBe(true);
  });

  test("prefers executor validation evidence over planner guidance when deriving excerpts", () => {
    const context = makeRoundContext();
    context.stateChange = [
      "### Snapshot File Diffs",
      "```diff",
      "--- src/utils/db.ts",
      "+++ src/utils/db.ts",
      "@@ -296,6 +296,12 @@",
      "+      hotFilePressureCount: hotFilePressure?.count || 0,",
      "--- web/src/App.tsx",
      "+++ web/src/App.tsx",
      "@@ -840,6 +850,12 @@",
      "+          <p className=\"text-[10px] uppercase tracking-widest text-mist/50\">Hot-File Pressure</p>",
      "+          <p className=\"text-[10px] uppercase tracking-[0.18em] text-mist/45\">governance blocks</p>",
      "```"
    ].join("\n");
    context.logLines = [
      "[planner] validation: Prefer sub-tasks with clear verification steps and visible user value.",
      "[planner] failure history should influence the next rationale.",
      "[executor] /bin/zsh -lc 'bun test src/server.test.ts web/src/App.test.tsx' in /Users/yinjames/projects/AILoop",
      "[executor] run_shell_command: Ran `bun test src/server.test.ts web/src/App.test.tsx` in `/Users/yinjames/projects/AILoop` and confirmed `61 pass, 0 fail`.",
      "[executor] +      hotFilePressureCount: hotFilePressure?.count || 0,",
      "[executor] +          <p className=\"text-[10px] uppercase tracking-widest text-mist/50\">Hot-File Pressure</p>"
    ];

    const roundContext = extractPromptRoundContext(buildDimensionPrompt("goal_alignment", context));
    const validationSummary = roundContext.validation_summary as Record<string, unknown>;
    const highlightedSignals = validationSummary.highlighted_signals as string[];
    const targetedExcerpts = roundContext.targeted_excerpts as Array<Record<string, string>>;

    expect(validationSummary.status).toBe("derived");
    expect(highlightedSignals.some((signal) => signal.includes("61 pass, 0 fail"))).toBe(true);
    expect(highlightedSignals.some((signal) => signal.includes("hotFilePressureCount"))).toBe(true);
    expect(targetedExcerpts.some((excerpt) => excerpt.excerpt.includes("61 pass, 0 fail"))).toBe(true);
    expect(targetedExcerpts.some((excerpt) => excerpt.excerpt.includes("hotFilePressureCount"))).toBe(true);
    expect(targetedExcerpts.some((excerpt) => excerpt.excerpt.includes("Hot-File Pressure"))).toBe(true);
    expect(targetedExcerpts[0]?.source).toBe("state_change_excerpt");
  });

  test("prefers direct state-change assertions over recursive evaluator log echoes", () => {
    const context = makeRoundContext();
    context.stateChange = [
      "### Snapshot File Diffs",
      "```diff",
      "--- web/src/App.test.tsx",
      "+++ web/src/App.test.tsx",
      "@@ -170,6 +170,18 @@",
      '+    expect(html).toContain("Hot-File Governance");',
      '+    expect(html).toContain("web/src/App.tsx");',
      '+    expect(html).toContain("pause and split the next edit into a bounded follow-up");',
      "--- web/src/App.tsx",
      "+++ web/src/App.tsx",
      "@@ -1854,6 +1854,10 @@",
      "+                      <HotFileGovernancePanel signal={hotFileGovernance} compact />",
      "```"
    ].join("\n");
    context.logLines = [
      '[04:49:29][evaluator] "[04:45:28][executor] {\\"actions\\":[\\"read_file: inspected web/src/App.tsx\\",\\"run_shell_command: Ran `bun test web/src/App.test.tsx` and confirmed `20 pass, 0 fail`.\\"]}"',
      '[04:49:31][evaluator] "[04:45:38][evaluator] \\"[04:45:28][executor] {\\\\\\"actions\\\\\\":[\\\\\\"read_file\\\\\\"]}\\""',
      "[executor] run_shell_command: Ran `bun test web/src/App.test.tsx` and confirmed `20 pass, 0 fail`."
    ];

    const roundContext = extractPromptRoundContext(buildDimensionPrompt("goal_alignment", context));
    const validationSummary = roundContext.validation_summary as Record<string, unknown>;
    const highlightedSignals = validationSummary.highlighted_signals as string[];
    const targetedExcerpts = roundContext.targeted_excerpts as Array<Record<string, string>>;

    expect(highlightedSignals.some((signal) => signal.includes('expect(html).toContain("Hot-File Governance")'))).toBe(true);
    expect(targetedExcerpts[0]?.source).toBe("state_change_excerpt");
    expect(targetedExcerpts[0]?.excerpt).toContain('expect(html).toContain("Hot-File Governance")');
    expect(targetedExcerpts.some((excerpt) => excerpt.excerpt.includes("[evaluator]"))).toBe(false);
    expect(targetedExcerpts.some((excerpt) => excerpt.excerpt.includes("\\\"actions\\\""))).toBe(false);
  });
});

describe("LLMJudgeEvaluator logging", () => {
  test("emits evaluator progress and streamed codex output to onLog", async () => {
    const logs: string[] = [];
    const context: RoundEvaluationContext = {
      ...makeRoundContext(),
      onLog: (message) => {
        logs.push(message);
      }
    };

    const mockCodex = {
      async runJson<T>(options: { onStdoutChunk?: (chunk: string) => void; onStderrChunk?: (chunk: string) => void }) {
        options.onStdoutChunk?.("stdout from evaluator\n");
        options.onStderrChunk?.("stderr from evaluator\n");
        return {
          ok: true,
          data: {
            dimension: "goal_alignment",
            decision: "pass",
            score: 90,
            confidence: 0.9,
            justification: "ok",
            evidence: ["evidence"],
            blocking_issues: [],
            recommended_next_action: "continue"
          } as unknown as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const evaluator = new LLMJudgeEvaluator(makeLlmConfig(), mockCodex as never);
    const result = await evaluator.evaluate(context);

    expect(result.decision).toBe("pass");
    expect(logs.some((line) => line.includes("Evaluator started LLM dimension checks"))).toBe(true);
    expect(logs.some((line) => line.includes("Evaluator checking dimension: goal_alignment"))).toBe(true);
    expect(logs.some((line) => line.includes("[evaluator] stdout from evaluator"))).toBe(true);
    expect(logs.some((line) => line.includes("[evaluator] stderr from evaluator"))).toBe(true);
  });
});
