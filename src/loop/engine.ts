import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { AppConfig } from "../config/env";
import { ExecutorAgent } from "../agent/executor";
import { Guardrails, BudgetBreachError } from "../agent/guardrails";
import { PlannerAgent } from "../agent/planner";
import { ToolRegistry } from "../agent/tool-registry";
import { WorkspaceManager } from "../environment/workspace";
import { createEvaluator } from "../evaluation/evaluator";
import { writeMetricsFile, type RoundMetrics } from "../reporting/metrics";
import {
  buildRoundArtifactPaths,
  trimOldRuns,
  writeLogFile,
  writeStateChangeFile,
  writeSummaryFile
} from "../reporting/summary";
import type { LoopStateName, SubTask, ToolResult } from "../types/contracts";
import { SecretRedactor } from "../utils/redaction";
import { runTimestamp } from "../utils/time";
import { cooldownWithControlChecks, waitWhilePaused } from "./scheduler";
import {
  buildLoopPaths,
  clearFlag,
  clearPid,
  defaultLoopState,
  drainInstructions,
  ensureLoopHome,
  hasFlag,
  readLoopState,
  setFlag,
  updateLoopState,
  writeLoopState,
  writePid
} from "./state";

export class LoopEngine {
  private readonly paths;
  private readonly planner: PlannerAgent;
  private readonly tools: ToolRegistry;
  private readonly executor: ExecutorAgent;
  private readonly evaluator;
  private readonly redactor = new SecretRedactor(process.env);
  private previousToolResult: ToolResult | null = null;

  private lockHandle: FileHandle | null = null;

  constructor(private readonly config: AppConfig) {
    this.paths = buildLoopPaths(config.homeDir);
    this.tools = new ToolRegistry();
    this.planner = new PlannerAgent(config);
    this.executor = new ExecutorAgent(this.tools, config);
    this.evaluator = createEvaluator(config);
  }

  async run(): Promise<void> {
    await ensureLoopHome(this.paths);
    await this.acquireLock();
    await this.setState("running");
    await writePid(this.paths, process.pid);

    try {
      let currentState = await readLoopState(this.paths);
      let round = currentState.round;

      while (true) {
        if (await hasFlag(this.paths.stopFlagPath)) {
          await this.setState("stopping");
          break;
        }

        if (await hasFlag(this.paths.pauseFlagPath)) {
          await this.setState("paused");
          const pausedResult = await waitWhilePaused(this.paths);
          if (pausedResult === "stopped") {
            await this.setState("stopping");
            break;
          }
          await this.setState("running");
        }

        if (this.config.maxCycles > 0 && round >= this.config.maxCycles) {
          await this.setState("stopping");
          break;
        }

        round += 1;
        const roundOutcome = await this.runRound(round);

        if (!roundOutcome.success && this.config.exitOnError) {
          await this.setState("error", roundOutcome.errorMessage);
          break;
        }

        if (!roundOutcome.success) {
          await setFlag(this.paths.pauseFlagPath);
          await this.setState("paused", roundOutcome.errorMessage ?? "round failed");
          continue;
        }

        const cooldownResult = await cooldownWithControlChecks(this.paths, this.config.intervalSeconds);
        if (cooldownResult === "stop") {
          await this.setState("stopping");
          break;
        }
      }

      await clearFlag(this.paths.stopFlagPath);
      await writeLoopState(this.paths, {
        ...(await readLoopState(this.paths)),
        state: "idle",
        pid: null,
        last_error: null
      });
    } catch (error) {
      await this.setState("error", (error as Error).message);
      throw error;
    } finally {
      await clearPid(this.paths);
      await this.releaseLock();
    }
  }

  private async runRound(round: number): Promise<{ success: boolean; errorMessage?: string }> {
    const startedAt = Date.now();
    const runId = runTimestamp();
    const artifacts = buildRoundArtifactPaths(this.paths.runsDir, runId);
    const logLines: string[] = [];
    const log = (message: string): void => {
      logLines.push(`[${new Date().toISOString()}] ${this.redactor.redact(message)}`);
    };

    const workspace = new WorkspaceManager(this.paths);
    const snapshot = await workspace.createSnapshot();
    const guardrails = new Guardrails(this.config.budget);

    let subTask: SubTask = {
      rationale: "Round initialization",
      objective: "Initialize round context",
      expected_outcome: "Context initialized",
      recommended_tools: []
    };
    let stateChange = "No state changes detected.\n";

    try {
      const goal = await fs.readFile(this.paths.goalPath, "utf8");
      const instructions = await drainInstructions(this.paths);
      const priorState = await readLoopState(this.paths);

      subTask = await this.planner.plan({
        goal,
        instructions,
        round,
        budget: this.config.budget,
        previous_tool_result: this.previousToolResult
      });

      log(`Planner objective: ${subTask.objective}`);
      const execution = await this.executor.execute({
        subTask,
        round,
        goal,
        instructions,
        guardrails,
        paths: this.paths
      });

      stateChange = await workspace.buildStateChange(snapshot);
      execution.toolResult.artifacts.log_path = artifacts.logPath;
      execution.toolResult.artifacts.state_change_path = artifacts.stateChangePath;

      const evaluation = await this.evaluator.evaluate({
        subTask,
        toolResult: execution.toolResult,
        stateChange,
        logLines,
        runTimestamp: runId
      });

      if (evaluation.decision === "fail" || execution.toolResult.status === "failure") {
        await workspace.rollback(snapshot);
        stateChange = `${stateChange}\nRollback: workspace snapshot restored due to failed round.\n`;
      }

      const usage = guardrails.usage();
      const metrics: RoundMetrics = {
        round,
        run_timestamp: runId,
        duration_ms: Date.now() - startedAt,
        budget_limits: guardrails.limitsSnapshot(),
        budget_usage: usage,
        evaluator_decision: evaluation.decision,
        tool_status: execution.toolResult.status
      };

      const risks: string[] = [];
      if (execution.toolResult.status === "failure") {
        risks.push(execution.toolResult.error?.message ?? "Executor returned failure");
      }
      if (evaluation.decision === "fail") {
        risks.push(evaluation.justification);
      }

      await writeStateChangeFile(artifacts.stateChangePath, stateChange);
      await writeLogFile(artifacts.logPath, logLines);
      await writeMetricsFile(artifacts.metricsPath, metrics);
      await writeSummaryFile(artifacts.summaryPath, {
        goal,
        subTask,
        actions: execution.actions,
        toolResult: execution.toolResult,
        evaluation,
        metrics,
        risks,
        nextRecommendation: evaluation.recommended_next_action ?? "continue"
      });

      await trimOldRuns(this.paths.runsDir, this.config.maxRetainRuns);

      const nextFailureCount = evaluation.decision === "fail" ? priorState.consecutive_evaluator_failures + 1 : 0;
      this.previousToolResult = execution.toolResult;

      await writeLoopState(this.paths, {
        ...priorState,
        round,
        state: nextFailureCount >= 3 ? "paused" : priorState.state,
        pid: process.pid,
        last_error: execution.toolResult.error?.message ?? (evaluation.decision === "fail" ? evaluation.justification : null),
        consecutive_evaluator_failures: nextFailureCount,
        current_budget: {
          limits: guardrails.limitsSnapshot(),
          usage
        }
      });

      if (nextFailureCount >= 3 || evaluation.decision === "fail" || execution.toolResult.status === "failure") {
        return {
          success: false,
          errorMessage: execution.toolResult.error?.message ?? evaluation.justification
        };
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof BudgetBreachError ? error.message : (error as Error).message;
      const errorType = error instanceof BudgetBreachError ? "BudgetBreach" : "RoundExecutionError";
      const failureToolResult: ToolResult = {
        status: "failure",
        summary: "Round failed before evaluation completed.",
        artifacts: {
          log_path: artifacts.logPath,
          state_change_path: artifacts.stateChangePath
        },
        error: {
          type: errorType,
          message
        },
        next_state_hint: "pause"
      };

      await workspace.rollback(snapshot);
      stateChange = `${stateChange}\nRollback: workspace snapshot restored after round error.\n`;

      const usage = guardrails.usage();
      const metrics: RoundMetrics = {
        round,
        run_timestamp: runId,
        duration_ms: Date.now() - startedAt,
        budget_limits: guardrails.limitsSnapshot(),
        budget_usage: usage,
        evaluator_decision: "fail",
        tool_status: "failure"
      };

      await writeStateChangeFile(artifacts.stateChangePath, stateChange);
      log(`Round error: ${message}`);
      await writeLogFile(artifacts.logPath, logLines);
      await writeMetricsFile(artifacts.metricsPath, metrics);
      await writeSummaryFile(artifacts.summaryPath, {
        goal: "",
        subTask,
        actions: [],
        toolResult: failureToolResult,
        evaluation: {
          decision: "fail",
          justification: message,
          evidence: [message],
          recommended_next_action: "pause and inspect round error"
        },
        metrics,
        risks: [message],
        nextRecommendation: "pause"
      });

      await updateLoopState(this.paths, (current) => ({
        ...current,
        round,
        state: "paused",
        pid: process.pid,
        last_error: message,
        consecutive_evaluator_failures: current.consecutive_evaluator_failures + 1,
        current_budget: {
          limits: guardrails.limitsSnapshot(),
          usage
        }
      }));

      return { success: false, errorMessage: message };
    }
  }

  private async setState(state: LoopStateName, lastError: string | null = null): Promise<void> {
    await updateLoopState(this.paths, (current) => ({
      ...current,
      state,
      pid: process.pid,
      last_error: lastError
    }));
  }

  private async acquireLock(): Promise<void> {
    const tryAcquire = async (): Promise<boolean> => {
      try {
        this.lockHandle = await fs.open(this.paths.lockPath, "wx");
        await this.lockHandle.writeFile(`${process.pid}\n`);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          return false;
        }
        throw error;
      }
    };

    if (await tryAcquire()) {
      return;
    }

    const rawLockPid = await fs.readFile(this.paths.lockPath, "utf8").catch(() => "");
    const lockPid = Number(rawLockPid.trim());
    const lockPidAlive =
      Number.isInteger(lockPid) && lockPid > 0
        ? (() => {
            try {
              process.kill(lockPid, 0);
              return true;
            } catch {
              return false;
            }
          })()
        : false;

    if (lockPidAlive) {
      throw new Error("Another loop instance appears to be running (lock file exists).");
    }

    await fs.rm(this.paths.lockPath, { force: true });
    if (!(await tryAcquire())) {
      throw new Error("Could not acquire loop lock after clearing stale lock file.");
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockHandle) {
      await this.lockHandle.close();
      this.lockHandle = null;
    }

    try {
      await fs.unlink(this.paths.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
