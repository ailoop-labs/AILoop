import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import type { ActionRecord, EvaluationResult, SubTask, ToolResult } from "../types/contracts";
import { ensureLoopHome, readLoopState, type LoopPaths, writeLoopState } from "./state";
import {
  LoopEngine,
  collectOperationalEvidence,
  extractSnapshotTargetsFromSubTask,
  resolveNextLastError
} from "./engine";

async function waitForPausedState(paths: LoopPaths, timeoutMs = 6_000): Promise<Awaited<ReturnType<typeof readLoopState>>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readLoopState(paths);
    if (state.state === "paused") {
      return state;
    }
    await Bun.sleep(50);
  }

  throw new Error("Timed out waiting for paused state.");
}

function makeToolResult(summary: string): ToolResult {
  return {
    status: "success",
    summary,
    artifacts: {
      log_path: "",
      state_change_path: ""
    },
    error: null,
    next_state_hint: "continue"
  };
}

function makeEvaluation(decision: EvaluationResult["decision"], justification: string): EvaluationResult {
  return {
    decision,
    justification,
    evidence: ["test-evidence"],
    recommended_next_action: "add targeted verification"
  };
}

function makeAction(tool: string): ActionRecord {
  return {
    tool,
    args: {},
    ok: true,
    output: `${tool} ok`
  };
}

describe("extractSnapshotTargetsFromSubTask", () => {
  test("extracts backticked file paths from objective and outcome", () => {
    const workspaceRoot = "/tmp/workspace";
    const subTask: SubTask = {
      assignee: "executor",
  rationale: "test",
      objective: "Create `.ailoop/plans/round-7.md` with checklist.",
      expected_outcome: "File `src/loop/engine.ts` updated and `.ailoop/runs/report.txt` written.",
      recommended_tools: ["write_file"]
    };

    const targets = extractSnapshotTargetsFromSubTask(subTask, workspaceRoot);
    expect(targets).toContain(path.join(workspaceRoot, ".ailoop/plans/round-7.md"));
    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.ts"));
    expect(targets).toContain(path.join(workspaceRoot, ".ailoop/runs/report.txt"));
  });
});

describe("resolveNextLastError", () => {
  test("preserves previous error when transition does not provide one", () => {
    expect(resolveNextLastError("blocked", undefined)).toBe("blocked");
  });

  test("allows explicit clear when transition sets null", () => {
    expect(resolveNextLastError("blocked", null)).toBeNull();
  });

  test("writes explicit next error message when provided", () => {
    expect(resolveNextLastError("blocked", "new-error")).toBe("new-error");
  });
});

describe("LoopEngine auto rework", () => {
  test("writes a markdown summary artifact with core round details after a successful round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-summary-artifact-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist markdown round summary",
      expected_outcome: "round summary artifact exists with core sections",
      recommended_tools: ["read_file", "run_shell"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file"), makeAction("run_shell")],
      toolResult: makeToolResult("Created markdown summary artifact")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();

    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("# AILoop Round Summary");
    expect(summaryText).toContain("## Round Metadata");
    expect(summaryText).toContain("- Round: 1");
    expect(summaryText).toMatch(/- Timestamp: \d{4}-\d{2}-\d{2}T/);
    expect(summaryText).toContain("## Planned Sub-task");
    expect(summaryText).toContain("- Objective: Persist markdown round summary");
    expect(summaryText).toContain("## Execution Result");
    expect(summaryText).toContain("- Work Summary: Created markdown summary artifact");
    expect(summaryText).toContain("## Evaluation Result");
    expect(summaryText).toContain("- Decision: pass");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("writes a metrics artifact with round metadata, retry counts, and phase timings after a successful round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-metrics-artifact-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist metrics artifact",
      expected_outcome: "round metrics artifact exists with core fields",
      recommended_tools: ["read_file", "run_shell"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file"), makeAction("run_shell")],
      toolResult: makeToolResult("Created metrics artifact")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const metricsFile = runArtifacts.find((entry) => entry.endsWith(".round.metrics.json"));
    expect(metricsFile).toBeDefined();

    const metrics = JSON.parse(
      await fs.readFile(path.join(homeDir, "runs", metricsFile as string), "utf8")
    ) as Record<string, unknown>;
    expect(metrics.round).toBe(1);
    expect(metrics.run_timestamp).toEqual(expect.any(String));
    expect(metrics.duration_ms).toEqual(expect.any(Number));
    expect(metrics.budget_usage).toEqual(
      expect.objectContaining({
        usdUsed: expect.any(Number),
        actionsUsed: expect.any(Number),
        elapsedMs: expect.any(Number)
      })
    );
    expect(metrics.retries).toEqual({
      evidence_remediation_attempts: 0,
      auto_rework_attempts: 0,
      auto_rework_limit: config.evaluatorReworkMaxAttempts
    });
    expect(metrics.phase_timings_ms).toEqual(
      expect.objectContaining({
        planning: expect.any(Number),
        execution: expect.any(Number),
        evaluation: expect.any(Number),
        operational_followup: expect.any(Number)
      })
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("writes an evaluation artifact for each completed round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-evaluation-artifact-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist evaluator output",
      expected_outcome: "round evaluation artifact exists",
      recommended_tools: ["read_file", "write_file"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file")],
      toolResult: makeToolResult("persisted evaluation artifact")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const evaluationFile = runArtifacts.find((entry) => entry.endsWith(".round.evaluation.json"));
    expect(evaluationFile).toBeDefined();

    const evaluation = JSON.parse(
      await fs.readFile(path.join(homeDir, "runs", evaluationFile as string), "utf8")
    ) as Record<string, unknown>;
    expect(evaluation.decision).toBe("pass");
    expect(evaluation.justification).toBe("All checks satisfied.");
    expect(evaluation.evidence).toEqual(["test-evidence"]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("retries once after evaluator fail by feeding failure reason back to executor", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-rework-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_EVAL_REWORK_MAX_ATTEMPTS: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
  rationale: "test rationale",
      objective: "Implement one change",
      expected_outcome: "one verification passes",
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    const executorInputs: Array<{ subTask: SubTask; instructions: string[] }> = [];
    const execute = async (input: { subTask: SubTask; instructions: string[] }) => {
      executorInputs.push(input);
      if (executorInputs.length === 1) {
        return {
          actions: [makeAction("read_file")],
          toolResult: makeToolResult("initial change")
        };
      }
      return {
        actions: [makeAction("write_file"), makeAction("run_shell")],
        toolResult: makeToolResult("rework change")
      };
    };

    let evalCall = 0;
    const evaluate = async (): Promise<EvaluationResult> => {
      evalCall += 1;
      if (evalCall === 1) {
        return makeEvaluation("fail", "Missing negative tests for edge cases.");
      }
      return makeEvaluation("pass", "All checks satisfied.");
    };

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "commit abc1234, push ok, restart ok, health check ok",
      lines: [
        "Commit: abc1234 test",
        "Push: Everything up-to-date",
        "Restart: PID 4242, log .ailoop/prod.server.log",
        "Health Check: GET /api/health -> 200 OK",
        "Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart"
      ],
      stateChangeNotes: ["Shell: git push origin HEAD -> ok (Everything up-to-date)"]
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    expect(executorInputs.length).toBe(2);
    expect(evalCall).toBe(2);
    expect(executorInputs[1]?.instructions.join("\n")).toContain("Evaluator failure");
    expect(executorInputs[1]?.instructions.join("\n")).toContain("Missing negative tests");
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();
    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("## Auto Rework Attempts");
    expect(summaryText).toContain("Attempt 1/1:");
    expect(summaryText).toContain("trigger='Missing negative tests for edge cases.'");
    expect(summaryText).toContain("evaluation=pass");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("collectOperationalEvidence records commit, push, restart, health, and rollback details", async () => {
    const commands: string[] = [];
    const evidence = await collectOperationalEvidence(
      {
        round: 5,
        objective: "tighten deploy evidence",
        expectedOutcome: "summary includes deploy evidence",
        consolePort: 3090,
        log: async () => {
          // no-op
        }
      },
      async (command) => {
        commands.push(command);
        if (command === "git add .") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git diff --cached --quiet") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (command.startsWith("git commit -m ")) {
          return { code: 0, stdout: "[main abc1234] AILoop Round 5: tighten deploy evidence", stderr: "" };
        }
        if (command === "git rev-parse --short HEAD") {
          return { code: 0, stdout: "abc1234\n", stderr: "" };
        }
        if (command === "git log -1 --pretty=%s") {
          return { code: 0, stdout: "AILoop Round 5: tighten deploy evidence\n", stderr: "" };
        }
        if (command === "git push origin HEAD") {
          return { code: 0, stdout: "Everything up-to-date", stderr: "" };
        }
        if (command === "bash scripts/prod.sh restart") {
          return {
            code: 0,
            stdout: [
              "Restart requested: stopping current server gracefully.",
              "Started in daemon mode.",
              "PID: 4242",
              "Log: .ailoop/prod.server.log"
            ].join("\n"),
            stderr: ""
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      async () => ({
        ok: true,
        status: 200,
        body: '{"ok":true,"service":"ailoop-console"}'
      })
    );

    expect(commands).toEqual([
      "git add .",
      "git diff --cached --quiet",
      expect.stringContaining("git commit -m \"AILoop Round 5: tighten deploy evidence"),
      "git rev-parse --short HEAD",
      "git log -1 --pretty=%s",
      "git push origin HEAD",
      "bash scripts/prod.sh restart"
    ]);
    expect(evidence.summaryNote).toContain("commit abc1234");
    expect(evidence.summaryNote).toContain("push ok");
    expect(evidence.summaryNote).toContain("restart ok");
    expect(evidence.summaryNote).toContain("health check ok");
    expect(evidence.lines).toContain("Commit: abc1234 AILoop Round 5: tighten deploy evidence");
    expect(evidence.lines).toContain("Push: Everything up-to-date");
    expect(evidence.lines).toContain("Restart: PID 4242, log .ailoop/prod.server.log");
    expect(evidence.lines).toContain("Health Check: GET /api/health -> 200 OK");
    expect(evidence.lines).toContain("Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart");
    expect(evidence.stateChangeNotes).toContain("Shell: git push origin HEAD -> ok (Everything up-to-date)");
  });
});

describe("LoopEngine time budget guard", () => {
  test("pauses before next action when elapsed round time exceeds limit", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-time-guard-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_BUDGET_TIME_MINUTES: "0.001" // 60ms
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
  rationale: "test rationale",
      objective: "Execute bounded task",
      expected_outcome: "executor runs after planning",
      recommended_tools: ["read_file", "run_shell"]
    };

    let executorCalls = 0;
    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: () => Promise<{ actions: ActionRecord[]; toolResult: ToolResult }> };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        await Bun.sleep(80);
        return plan;
      }
    };
    mutable.executor = {
      execute: async () => {
        executorCalls += 1;
        return {
          actions: [makeAction("run_shell")],
          toolResult: makeToolResult("executor should not run when time budget is exceeded")
        };
      }
    };
    mutable.evaluator = {
      evaluate: async () => makeEvaluation("pass", "unused")
    };

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toContain("BudgetBreach: time budget exceeded");
    expect(executorCalls).toBe(0);

    const state = await readLoopState(paths);
    expect(state.state).toBe("paused");
    expect(state.last_error).toContain("BudgetBreach: time budget exceeded");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("LoopEngine round error handling", () => {
  test("preserves seeded evaluator failure count on pre-evaluation execution errors", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-round-error-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    const seededState = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seededState,
      consecutive_evaluator_failures: 2
    });

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        // Simulate an intermediate state write before the round errors out.
        const midRoundState = await readLoopState(paths);
        await writeLoopState(paths, {
          ...midRoundState,
          consecutive_evaluator_failures: 9
        });
        throw new Error("planner exploded before execution");
      }
    };

    const outcome = await mutable.runRound(1);
    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toBe("planner exploded before execution");

    const state = await readLoopState(paths);
    expect(state.previous_tool_result?.status).toBe("failure");
    expect(state.previous_tool_result?.error?.type).toBe("RoundExecutionError");
    expect(state.previous_tool_result?.next_state_hint).toBe("continue");
    expect(state.consecutive_evaluator_failures).toBe(9);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("LoopEngine crash recovery on startup", () => {
  test("pauses before starting a new round when persisted state shows an interrupted run", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-crash-recovery-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const seededState = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seededState,
      round: 4,
      state: "running",
      pid: 999999,
      current_budget: {
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 7,
          elapsedMs: 12_000
        }
      }
    });

    let runRoundCalls = 0;
    const mutable = engine as unknown as {
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
      run: () => Promise<void>;
    };
    mutable.runRound = async () => {
      runRoundCalls += 1;
      return { success: true };
    };

    let runPromise: Promise<void> | null = null;
    try {
      runPromise = mutable.run();
      const pausedState = await waitForPausedState(paths);

      expect(runRoundCalls).toBe(0);
      expect(pausedState.state).toBe("paused");
      expect(pausedState.round).toBe(4);
      expect(pausedState.current_budget).toEqual({
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 7,
          elapsedMs: 12_000
        }
      });
      expect(pausedState.last_error || "").toContain("Interrupted");
      expect(pausedState.last_error || "").toContain("startup");
    } finally {
      await fs.writeFile(paths.stopFlagPath, "1\n", "utf8");
      if (runPromise) {
        await Promise.race([
          runPromise,
          Bun.sleep(6_000).then(() => {
            throw new Error("Timed out stopping loop engine.");
          })
        ]);
      }
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
