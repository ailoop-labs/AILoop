import fs from "node:fs/promises";
import path from "node:path";
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
  appendLogLine,
  buildRoundArtifactPaths,
  trimOldRuns,
  writeLogFile,
  writeStateChangeFile,
  writeSummaryFile
} from "../reporting/summary";
import type { EvaluationResult, LoopStateName, SubTask, ToolResult } from "../types/contracts";
import { fileExists } from "../utils/fs";
import { SecretRedactor } from "../utils/redaction";
import { runTimestamp } from "../utils/time";
import { generateProjectGoal } from "../agent/goal-generator";
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

const INSUFFICIENT_EVIDENCE_PREFIX = "Insufficient evidence for key dimensions:";

function extractMissingKeyDimensions(justification: string): string[] {
  const trimmed = justification.trim();
  if (!trimmed.startsWith(INSUFFICIENT_EVIDENCE_PREFIX)) {
    return [];
  }

  return trimmed
    .slice(INSUFFICIENT_EVIDENCE_PREFIX.length)
    .split(",")
    .map((item) => item.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePathToken(token: string): string {
  return token.trim().replace(/[),.;:]+$/g, "");
}

function extractPathTokens(text: string): string[] {
  const tokens: string[] = [];
  const backtickRegex = /`([^`\n]+)`/g;
  for (const match of text.matchAll(backtickRegex)) {
    const value = normalizePathToken(match[1] ?? "");
    if (value) {
      tokens.push(value);
    }
  }

  const plainRegex = /\b(?:\.\/)?(?:src|scripts|web\/src|\.autoloop)\/[A-Za-z0-9._/-]+/g;
  for (const match of text.matchAll(plainRegex)) {
    const value = normalizePathToken(match[0] ?? "");
    if (value) {
      tokens.push(value);
    }
  }

  return tokens;
}

export function extractSnapshotTargetsFromSubTask(subTask: SubTask, workspaceRoot: string): string[] {
  const tokens = [...extractPathTokens(subTask.objective), ...extractPathTokens(subTask.expected_outcome)];
  const normalized = tokens
    .filter((token) => !token.includes("://"))
    .map((token) => (path.isAbsolute(token) ? token : path.resolve(workspaceRoot, token)))
    .filter((candidate) => isPathInside(workspaceRoot, candidate));
  return Array.from(new Set(normalized));
}

export function resolveNextLastError(currentLastError: string | null, requestedLastError?: string | null): string | null {
  if (requestedLastError === undefined) {
    return currentLastError;
  }
  return requestedLastError;
}

function buildEvaluatorReworkSubTask(
  originalTask: SubTask,
  attempt: number,
  maxAttempts: number
): SubTask {
  return {
    rationale: `Evaluator returned fail. Execute auto-rework attempt ${attempt}/${maxAttempts} with minimal scope to satisfy evaluator blockers.`,
    objective: `Revise the current round output to resolve evaluator failure for objective '${originalTask.objective}'.`,
    expected_outcome:
      "Updated code/tests plus explicit verification evidence address evaluator feedback and produce a pass decision.",
    recommended_tools: ["read_file", "write_file", "run_shell"]
  };
}

function buildEvaluatorReworkInstructions(
  baseInstructions: string[],
  evaluation: EvaluationResult,
  attempt: number,
  maxAttempts: number
): string[] {
  const next = [...baseInstructions, `Evaluator failure: ${evaluation.justification}`];
  if (evaluation.recommended_next_action?.trim()) {
    next.push(`Evaluator recommended next action: ${evaluation.recommended_next_action.trim()}`);
  }
  next.push(
    `Auto rework attempt ${attempt}/${maxAttempts}: apply the smallest safe change that resolves blocking issues, then run verification and capture concrete evidence in artifacts.`
  );
  return next;
}

function sanitizeReworkNote(value: string | undefined | null): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 200 ? `${normalized.slice(0, 197)}...` : normalized;
}

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
    const exists = await fileExists(this.paths.goalPath);
    let shouldGenerate = !exists;
    if (exists) {
      const content = await fs.readFile(this.paths.goalPath, "utf8");
      if (content.trim() === "# AutoLoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.") {
        shouldGenerate = true;
      }
    }

    if (shouldGenerate) {
      await ensureLoopHome(this.paths, await generateProjectGoal(this.config));
    } else {
      await ensureLoopHome(this.paths);
    }
    await this.acquireLock();
    await this.setState("running");
    await writePid(this.paths, process.pid);

    try {
      let currentState = await readLoopState(this.paths);
      let round = currentState.round;
      const stopAtRound = this.config.maxCycles > 0 ? round + this.config.maxCycles : null;

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

        if (stopAtRound !== null && round >= stopAtRound) {
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

        await this.setState("cooldown");
        const cooldownResult = await cooldownWithControlChecks(this.paths, this.config.intervalSeconds);
        if (cooldownResult === "stop") {
          await this.setState("stopping");
          break;
        }
        await this.setState("running");
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
    const log = async (message: string): Promise<void> => {
      const line = `[${new Date().toISOString()}] ${this.redactor.redact(message)}`;
      logLines.push(line);
      await appendLogLine(artifacts.logPath, line);
    };
    await writeLogFile(artifacts.logPath, []);
    await log(`Round ${round} started.`);

    const workspace = new WorkspaceManager(this.paths);
    let snapshot = await workspace.createSnapshot();
    const guardrails = new Guardrails(this.config.budget);
    const pauseForBudgetBreach = async (
      error: BudgetBreachError,
      actionName: string,
      source: "pre-action-time-guard" | "guardrails.checkBudget"
    ): Promise<void> => {
      await log(`Budget guard blocked ${actionName} (${source}): ${error.message}`);
      await setFlag(this.paths.pauseFlagPath);
      await this.setState("paused", error.message);
    };
    const enforceBudgetBeforeAction = async (actionName: string): Promise<void> => {
      const elapsedMs = Date.now() - startedAt;
      const timeLimitMs = this.config.budget.timeMinutes * 60_000;
      if (elapsedMs > timeLimitMs) {
        const timeBreach = new BudgetBreachError("time", "BudgetBreach: time budget exceeded");
        await pauseForBudgetBreach(timeBreach, actionName, "pre-action-time-guard");
        throw timeBreach;
      }

      try {
        guardrails.checkBudget();
      } catch (error) {
        if (error instanceof BudgetBreachError) {
          await pauseForBudgetBreach(error, actionName, "guardrails.checkBudget");
        }
        throw error;
      }
    };

    let subTask: SubTask = {
      rationale: "Round initialization",
      objective: "Initialize round context",
      expected_outcome: "Context initialized",
      recommended_tools: []
    };
    let stateChange = "No state changes detected.\n";
    const autoReworkAttempts: string[] = [];

    try {
      await enforceBudgetBeforeAction("round.bootstrap");
      const goal = await fs.readFile(this.paths.goalPath, "utf8");
      const instructions = await drainInstructions(this.paths);
      const priorState = await readLoopState(this.paths);
      const plannerPreviousToolResult = this.previousToolResult ?? priorState.previous_tool_result;

      await enforceBudgetBeforeAction("planner.plan");
      subTask = await this.planner.plan(
        {
          goal,
          instructions,
          round,
          budget: this.config.budget,
          previous_tool_result: plannerPreviousToolResult,
          previous_round_error: priorState.last_error,
          consecutive_evaluator_failures: priorState.consecutive_evaluator_failures
        },
        {
          onLog: log
        }
      );
      const snapshotTargets = extractSnapshotTargetsFromSubTask(subTask, process.cwd());
      snapshot = await workspace.createSnapshot(snapshotTargets);

      await log(`Planner objective: ${subTask.objective}`);
      await enforceBudgetBeforeAction("executor.execute");
      const execution = await this.executor.execute({
        subTask,
        round,
        goal,
        instructions,
        guardrails,
        paths: this.paths,
        onLog: log
      });
      const actions = [...execution.actions];
      let finalToolResult: ToolResult = {
        ...execution.toolResult
      };
      await log(`Executor finished with status: ${finalToolResult.status}.`);

      stateChange = await workspace.buildStateChange(snapshot);
      finalToolResult.artifacts.log_path = artifacts.logPath;
      finalToolResult.artifacts.state_change_path = artifacts.stateChangePath;

      await enforceBudgetBeforeAction("evaluator.evaluate");
      let evaluation: EvaluationResult = await this.evaluator.evaluate({
        subTask,
        toolResult: finalToolResult,
        stateChange,
        logLines,
        runTimestamp: runId,
        budgetLimits: guardrails.limitsSnapshot(),
        budgetUsage: guardrails.usage(),
        onLog: log
      });
      await log(`Evaluator decision: ${evaluation.decision}.`);

      const missingKeyDimensions = extractMissingKeyDimensions(evaluation.justification);
      if (
        evaluation.decision === "fail" &&
        finalToolResult.status === "success" &&
        missingKeyDimensions.length > 0
      ) {
        await log(
          `Evaluator reported insufficient evidence for key dimensions (${missingKeyDimensions.join(
            ", "
          )}). Triggering one evidence-remediation pass.`
        );

        const remediationTask: SubTask = {
          rationale:
            "Evaluator failed due to insufficient key-dimension evidence. Collect explicit, verifiable proof from workspace state and run outputs.",
          objective: `Collect and persist explicit evidence for these missing key dimensions: ${missingKeyDimensions.join(
            ", "
          )}.`,
          expected_outcome:
            "Round artifacts include concrete, machine-verifiable evidence that directly addresses each missing key dimension.",
          recommended_tools: ["read_file", "run_shell", "write_file"]
        };

        const remediationInstructions = [
          ...instructions,
          `Evaluator failure: ${evaluation.justification}`,
          "Collect concrete evidence from commands/files and persist it in workspace artifacts so evaluator can verify compliance."
        ];

        await enforceBudgetBeforeAction("executor.execute remediation");
        const remediation = await this.executor.execute({
          subTask: remediationTask,
          round,
          goal,
          instructions: remediationInstructions,
          guardrails,
          paths: this.paths,
          onLog: log
        });

        actions.push(...remediation.actions);
        if (remediation.toolResult.status === "success") {
          finalToolResult = {
            ...finalToolResult,
            summary: `${finalToolResult.summary} Evidence remediation: ${remediation.toolResult.summary}`,
            next_state_hint:
              remediation.toolResult.next_state_hint === "stop"
                ? "stop"
                : finalToolResult.next_state_hint
          };
          stateChange = await workspace.buildStateChange(snapshot);
          finalToolResult.artifacts.log_path = artifacts.logPath;
          finalToolResult.artifacts.state_change_path = artifacts.stateChangePath;
          await enforceBudgetBeforeAction("evaluator.evaluate remediation");
          evaluation = await this.evaluator.evaluate({
            subTask,
            toolResult: finalToolResult,
            stateChange,
            logLines,
            runTimestamp: runId,
            budgetLimits: guardrails.limitsSnapshot(),
            budgetUsage: guardrails.usage(),
            onLog: log
          });
          await log(`Post-remediation evaluation decision: ${evaluation.decision}.`);
        } else {
          finalToolResult = {
            ...remediation.toolResult,
            summary: `${finalToolResult.summary} Evidence remediation failed: ${remediation.toolResult.summary}`,
            artifacts: {
              log_path: artifacts.logPath,
              state_change_path: artifacts.stateChangePath
            }
          };
          await log(
            `Evidence remediation failed: ${remediation.toolResult.error?.message ?? "unknown remediation error"
            }`
          );
        }
      }

      if (evaluation.decision === "fail" && finalToolResult.status === "success") {
        for (let attempt = 1; attempt <= this.config.evaluatorReworkMaxAttempts; attempt += 1) {
          const triggerReason = sanitizeReworkNote(evaluation.justification);
          await log(
            `Evaluator failed; triggering auto-rework attempt ${attempt}/${this.config.evaluatorReworkMaxAttempts}.`
          );
          const reworkTask = buildEvaluatorReworkSubTask(
            subTask,
            attempt,
            this.config.evaluatorReworkMaxAttempts
          );
          await enforceBudgetBeforeAction(`executor.execute auto-rework ${attempt}`);
          const rework = await this.executor.execute({
            subTask: reworkTask,
            round,
            goal,
            instructions: buildEvaluatorReworkInstructions(
              instructions,
              evaluation,
              attempt,
              this.config.evaluatorReworkMaxAttempts
            ),
            guardrails,
            paths: this.paths,
            onLog: log
          });

          actions.push(...rework.actions);
          finalToolResult = {
            ...rework.toolResult,
            summary: `${finalToolResult.summary} Auto-rework ${attempt}/${this.config.evaluatorReworkMaxAttempts}: ${rework.toolResult.summary}`,
            artifacts: {
              log_path: artifacts.logPath,
              state_change_path: artifacts.stateChangePath
            }
          };

          if (rework.toolResult.status === "failure") {
            autoReworkAttempts.push(
              `Attempt ${attempt}/${this.config.evaluatorReworkMaxAttempts}: trigger='${triggerReason}', executor_status=failure, error='${sanitizeReworkNote(rework.toolResult.error?.message) || "unknown"
              }'`
            );
            await log(
              `Auto-rework attempt ${attempt}/${this.config.evaluatorReworkMaxAttempts} failed: ${rework.toolResult.error?.message ?? "unknown executor error"
              }`
            );
            break;
          }

          stateChange = await workspace.buildStateChange(snapshot);
          await enforceBudgetBeforeAction(`evaluator.evaluate auto-rework ${attempt}`);
          evaluation = await this.evaluator.evaluate({
            subTask,
            toolResult: finalToolResult,
            stateChange,
            logLines,
            runTimestamp: runId,
            budgetLimits: guardrails.limitsSnapshot(),
            budgetUsage: guardrails.usage(),
            onLog: log
          });
          await log(`Post-auto-rework evaluation decision: ${evaluation.decision}.`);
          autoReworkAttempts.push(
            `Attempt ${attempt}/${this.config.evaluatorReworkMaxAttempts}: trigger='${triggerReason}', executor_status=success, evaluation=${evaluation.decision}, justification='${sanitizeReworkNote(
              evaluation.justification
            )}'`
          );
          if (evaluation.decision === "pass") {
            break;
          }
        }
      }

      if (evaluation.decision === "fail" || finalToolResult.status === "failure") {
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
        tool_status: finalToolResult.status
      };

      const risks: string[] = [];
      if (finalToolResult.status === "failure") {
        risks.push(finalToolResult.error?.message ?? "Executor returned failure");
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
        actions,
        toolResult: finalToolResult,
        evaluation,
        metrics,
        risks,
        autoReworkAttempts,
        nextRecommendation: evaluation.recommended_next_action ?? "continue"
      });

      await trimOldRuns(this.paths.runsDir, this.config.maxRetainRuns);

      const nextFailureCount = evaluation.decision === "fail" ? priorState.consecutive_evaluator_failures + 1 : 0;
      this.previousToolResult = finalToolResult;

      await writeLoopState(this.paths, {
        ...priorState,
        round,
        state: nextFailureCount >= 3 ? "paused" : priorState.state,
        pid: process.pid,
        last_error: finalToolResult.error?.message ?? (evaluation.decision === "fail" ? evaluation.justification : null),
        consecutive_evaluator_failures: nextFailureCount,
        previous_tool_result: finalToolResult,
        current_budget: {
          limits: guardrails.limitsSnapshot(),
          usage
        }
      });

      if (nextFailureCount >= 3 || evaluation.decision === "fail" || finalToolResult.status === "failure") {
        return {
          success: false,
          errorMessage: finalToolResult.error?.message ?? evaluation.justification
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
        next_state_hint: error instanceof BudgetBreachError ? "pause" : "continue"
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
      await log(`Round error: ${message}`);
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
        autoReworkAttempts: [],
        nextRecommendation: error instanceof BudgetBreachError ? "pause" : "continue"
      });

      const nextState = error instanceof BudgetBreachError ? "paused" : "running";

      await updateLoopState(this.paths, (current) => ({
        ...current,
        round,
        state: nextState,
        pid: process.pid,
        last_error: message,
        consecutive_evaluator_failures: current.consecutive_evaluator_failures + 1,
        previous_tool_result: failureToolResult,
        current_budget: {
          limits: guardrails.limitsSnapshot(),
          usage
        }
      }));

      return { success: false, errorMessage: message };
    }
  }

  private async setState(state: LoopStateName, lastError?: string | null): Promise<void> {
    await updateLoopState(this.paths, (current) => ({
      ...current,
      state,
      pid: process.pid,
      last_error: resolveNextLastError(current.last_error, lastError)
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
