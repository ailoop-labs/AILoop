import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ActionRecord } from "../types/contracts";
import type { SummaryInput } from "./summary";
import { appendLogLine, writeEvaluationFile, writeLogFile, writeStateChangeFile, writeSummaryFile } from "./summary";

async function withSecretEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const previousSessionSecret = process.env.SESSION_SECRET;

  process.env.OPENAI_API_KEY = "sk-test-secret";
  process.env.SESSION_SECRET = "super-secret-value";

  try {
    return await run();
  } finally {
    if (previousOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = previousSessionSecret;
    }
  }
}

function makeSummaryInput(autoReworkAttempts: string[]): SummaryInput {
  return {
    goal: "Test goal",
    subTask: {
      assignee: "executor",
      rationale: "test rationale",
      objective: "test objective",
      expected_outcome: "test outcome",
      impacted_files: [],
      recommended_tools: ["read_file"]
    },
    actions: [],
    toolResult: {
      status: "success",
      summary: "done",
      operational_evidence: [],
      artifacts: {
        state_change_path: ".ailoop/runs/example.round.state_change.txt",
        log_path: ".ailoop/runs/example.round.log"
      },
      error: undefined,
      next_state_hint: "continue"
    },
    evaluation: {
      decision: "pass",
      justification: "ok",
      evidence: ["proof"]
    },
    metrics: {
      round: 1,
      run_timestamp: "2026-03-01T00:00:00.000Z",
      duration_ms: 1000,
      budget_limits: {
        usdPerRound: 1,
        timeMinutes: 1,
        actions: 10
      },
      budget_usage: {
        usdUsed: 0.1,
        actionsUsed: 1,
        elapsedMs: 1000
      },
      evaluator_decision: "pass",
      tool_status: "success",
      retries: {
        evidence_remediation_attempts: 0,
        auto_rework_attempts: 0,
        auto_rework_limit: 1
      },
      phase_timings_ms: {
        planning: 100,
        execution: 300,
        evaluation: 200,
        operational_followup: 400
      }
    },
    stateChange: "No state changes detected.\n",
    risks: [],
    autoReworkAttempts,
    nextRecommendation: "continue"
  };
}

function makeAction(tool: string, output: string): ActionRecord {
  return {
    tool,
    args: {},
    ok: true,
    output
  };
}

describe("writeSummaryFile auto rework section", () => {
  test("renders attempt details when auto rework was executed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    await writeSummaryFile(summaryPath, makeSummaryInput(["Attempt 1/2: evaluation=fail", "Attempt 2/2: evaluation=pass"]));
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Auto Rework Attempts");
    expect(text).toContain("- Attempt 1/2: evaluation=fail");
    expect(text).toContain("- Attempt 2/2: evaluation=pass");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders explicit none message when no auto rework happened", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    await writeSummaryFile(summaryPath, makeSummaryInput([]));
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Auto Rework Attempts");
    expect(text).toContain("- No auto rework attempts were executed.");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders a paused round outcome when repeated auto rework attempts still fail evaluation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([
      "Attempt 1/2: evaluation=fail",
      "Attempt 2/2: evaluation=fail"
    ]);
    input.evaluation.decision = "fail";
    input.evaluation.justification = "Evaluator still rejected the paused history path.";
    input.metrics.evaluator_decision = "fail";
    input.nextRecommendation = "Inspect the evaluator findings and narrow the next sub-task before resuming.";

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Round Outcome");
    expect(text).toContain("Paused for operator review after 2 auto rework attempts still ended in evaluator failure.");
    expect(text).toContain("Next safe action: Inspect the evaluator findings and narrow the next sub-task before resuming.");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders operational evidence when provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([]);
    input.toolResult.operational_evidence = [
      "Verification: bun test src/evaluation/strategies/llm-judge.test.ts -> 9 passed",
      "Commit: abc1234 AILoop Round 5: tighten deploy evidence",
      "Restart: PID 4242, log .ailoop/prod.server.log",
      "Health Check: GET /api/health -> 200 OK",
      "Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart"
    ];

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Operational Evidence");
    expect(text).toContain("- Verification: bun test src/evaluation/strategies/llm-judge.test.ts -> 9 passed");
    expect(text).toContain("- Commit: abc1234 AILoop Round 5: tighten deploy evidence");
    expect(text).toContain("- Restart: PID 4242, log .ailoop/prod.server.log");
    expect(text).toContain("- Health Check: GET /api/health -> 200 OK");
    expect(text).toContain("- Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders ordered executor action details instead of collapsing to tool names", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([]);
    input.actions = [
      makeAction("read_file", "Inspected src/reporting/summary.ts before editing."),
      makeAction("run_shell", "bun test src/reporting/summary.test.ts src/loop/engine.summary-artifact.test.ts -> 2 passed")
    ];

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Executor Action Trace");
    expect(text).toContain("1. read_file: Inspected src/reporting/summary.ts before editing.");
    expect(text).toContain(
      "2. run_shell: bun test src/reporting/summary.test.ts src/loop/engine.summary-artifact.test.ts -> 2 passed"
    );
    expect(text).not.toContain("## Actions Taken (Tools Used)");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders the failure mode from round metrics when the round failed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([]);
    input.toolResult.status = "failure";
    input.toolResult.error = {
      type: "ExecutorFailure",
      message: "Codex exited with code 1"
    };
    input.evaluation.decision = "fail";
    input.metrics.evaluator_decision = "fail";
    input.metrics.tool_status = "failure";
    input.metrics.failure_mode = "execution_failure";

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Execution Result");
    expect(text).toContain("- Failure Mode: execution_failure");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders verification evidence as a dedicated block", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([]);
    input.evaluation.evidence = [
      "bun test src/reporting/summary.test.ts src/loop/engine.summary-artifact.test.ts -> 2 passed",
      "Summary artifact includes executor action trace and verification evidence."
    ];

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Verification Evidence");
    expect(text).toContain(
      "- bun test src/reporting/summary.test.ts src/loop/engine.summary-artifact.test.ts -> 2 passed"
    );
    expect(text).toContain("- Summary artifact includes executor action trace and verification evidence.");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders a compact material state change summary derived from the persisted diff", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([]);
    input.stateChange = [
      "### Snapshot File Diffs",
      "```diff",
      "diff --git a/src/reporting/summary.ts b/src/reporting/summary.ts",
      "--- a/src/reporting/summary.ts",
      "+++ b/src/reporting/summary.ts",
      "@@ -1,3 +1,8 @@",
      "+function summarizeMaterialStateChange() {",
      "+  return [];",
      "+}",
      "diff --git a/web/src/App.tsx b/web/src/App.tsx",
      "--- a/web/src/App.tsx",
      "+++ b/web/src/App.tsx",
      "@@ -20,3 +20,7 @@",
      "+<section>material state change</section>",
      "```"
    ].join("\n");

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Material State Change");
    expect(text).toContain("- Files changed: src/reporting/summary.ts, web/src/App.tsx");
    expect(text).toContain("- Added lines: 4");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("renders artifact references for the round summary bundle", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "2026-03-11T00-00-00-000Z.round.summary.md");
    const input = makeSummaryInput([]);
    input.artifacts = {
      summaryPath,
      metricsPath: path.join(dir, "2026-03-11T00-00-00-000Z.round.metrics.json"),
      logPath: path.join(dir, "2026-03-11T00-00-00-000Z.round.log"),
      stateChangePath: path.join(dir, "2026-03-11T00-00-00-000Z.round.state_change.txt"),
      evaluationPath: path.join(dir, "2026-03-11T00-00-00-000Z.round.evaluation.json")
    };
    input.toolResult.artifacts = {
      log_path: input.artifacts.logPath,
      state_change_path: input.artifacts.stateChangePath
    };

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Artifact References");
    expect(text).toContain(`- Summary: ${input.artifacts.summaryPath}`);
    expect(text).toContain(`- Metrics: ${input.artifacts.metricsPath}`);
    expect(text).toContain(`- Log: ${input.artifacts.logPath}`);
    expect(text).toContain(`- State Change: ${input.artifacts.stateChangePath}`);
    expect(text).toContain(`- Evaluation: ${input.artifacts.evaluationPath}`);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("redacts secret env values before persisting round artifacts", async () => {
    await withSecretEnv(async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
      const logPath = path.join(dir, "round.log");
      const stateChangePath = path.join(dir, "round.state_change.txt");
      const summaryPath = path.join(dir, "round.summary.md");

      await writeLogFile(logPath, [
        "Start OPENAI_API_KEY=sk-test-secret",
        "Exact value leak super-secret-value"
      ]);
      await appendLogLine(logPath, "append sk-test-secret");
      await writeStateChangeFile(
        stateChangePath,
        [
          "### Snapshot File Diffs",
          "```diff",
          "+OPENAI_API_KEY=sk-test-secret",
          "+const sessionSecret = \"super-secret-value\"",
          "```"
        ].join("\n")
      );

      const input = makeSummaryInput([]);
      input.toolResult.summary = "Used sk-test-secret while collecting evidence";
      input.toolResult.operational_evidence = ["SESSION_SECRET=super-secret-value"];
      input.evaluation.justification = "OPENAI_API_KEY=sk-test-secret should be masked";
      await writeSummaryFile(summaryPath, input);

      const logText = await fs.readFile(logPath, "utf8");
      const stateChangeText = await fs.readFile(stateChangePath, "utf8");
      const summaryText = await fs.readFile(summaryPath, "utf8");

      expect(logText).not.toContain("sk-test-secret");
      expect(logText).not.toContain("super-secret-value");
      expect(logText).toContain("OPENAI_API_KEY=[REDACTED]");
      expect(logText).toContain("Exact value leak [REDACTED]");
      expect(logText).toContain("append [REDACTED]");

      expect(stateChangeText).not.toContain("sk-test-secret");
      expect(stateChangeText).not.toContain("super-secret-value");
      expect(stateChangeText).toContain("+OPENAI_API_KEY=[REDACTED]");
      expect(stateChangeText).toContain('+const sessionSecret = "[REDACTED]"');

      expect(summaryText).not.toContain("sk-test-secret");
      expect(summaryText).not.toContain("super-secret-value");
      expect(summaryText).toContain("Used [REDACTED] while collecting evidence");
      expect(summaryText).toContain("SESSION_SECRET=[REDACTED]");
      expect(summaryText).toContain("OPENAI_API_KEY=[REDACTED] should be masked");

      await fs.rm(dir, { recursive: true, force: true });
    });
  });

  test("keeps evaluation artifacts as valid JSON after redaction", async () => {
    await withSecretEnv(async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
      const evaluationPath = path.join(dir, "round.evaluation.json");

      await writeEvaluationFile(evaluationPath, {
        decision: "pass",
        justification: 'OPENAI_API_KEY=sk-test-secret and SESSION_SECRET="super-secret-value" should be masked',
        evidence: [
          "OPENAI_API_KEY=sk-test-secret",
          'const sessionSecret = "super-secret-value"'
        ],
        recommended_next_action: "continue"
      });

      const raw = await fs.readFile(evaluationPath, "utf8");
      const parsed = JSON.parse(raw) as {
        justification: string;
        evidence: string[];
      };

      expect(parsed.justification).toContain("OPENAI_API_KEY=[REDACTED]");
      expect(parsed.justification).toContain("SESSION_SECRET=[REDACTED]");
      expect(parsed.evidence).toEqual([
        "OPENAI_API_KEY=[REDACTED]",
        'const sessionSecret = "[REDACTED]"'
      ]);

      await fs.rm(dir, { recursive: true, force: true });
    });
  });
});
