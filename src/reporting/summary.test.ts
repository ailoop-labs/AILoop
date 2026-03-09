import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { SummaryInput } from "./summary";
import { appendLogLine, writeLogFile, writeStateChangeFile, writeSummaryFile } from "./summary";

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
      rationale: "test rationale",
      objective: "test objective",
      expected_outcome: "test outcome",
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
      error: null,
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
      tool_status: "success"
    },
    risks: [],
    autoReworkAttempts,
    nextRecommendation: "continue"
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

  test("renders operational evidence when provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-summary-test-"));
    const summaryPath = path.join(dir, "round.summary.md");
    const input = makeSummaryInput([]);
    input.toolResult.operational_evidence = [
      "Verification: bun test src/evaluation/strategies/llm-judge.test.ts -> 9 passed",
      "Commit: abc1234 AILoop Round 5: tighten deploy evidence",
      "Restart: PID 4242, log .ailoop/prod.server.log",
      "Health Check: GET /api/health -> 200 OK",
      "Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart"
    ];

    await writeSummaryFile(summaryPath, input);
    const text = await fs.readFile(summaryPath, "utf8");

    expect(text).toContain("## Operational Evidence");
    expect(text).toContain("- Verification: bun test src/evaluation/strategies/llm-judge.test.ts -> 9 passed");
    expect(text).toContain("- Commit: abc1234 AILoop Round 5: tighten deploy evidence");
    expect(text).toContain("- Restart: PID 4242, log .ailoop/prod.server.log");
    expect(text).toContain("- Health Check: GET /api/health -> 200 OK");
    expect(text).toContain("- Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart");

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
});
