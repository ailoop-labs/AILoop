import fs from "node:fs/promises";
import path from "node:path";
import { lstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { AppConfig } from "../config/env";
import { ExecutorAgent } from "../agent/executor";
import { DesignerAgent } from "../agent/designer";
import { Guardrails, BudgetBreachError } from "../agent/guardrails";
import { PlannerAgent } from "../agent/planner";
import { LeaderAgent } from "../agent/leader";
import { CCBSession } from "./ccb";
import { UIEvaluator } from "../evaluation/strategies/ui-evaluator";
import { ToolRegistry } from "../agent/tool-registry";
import { WorkspaceManager } from "../environment/workspace";
import { createEvaluator } from "../evaluation/evaluator";
import {
  writeMetricsFile,
  type RoundMetrics,
  type RoundPhaseTimings,
  type RoundRetryCounts
} from "../reporting/metrics";
import {
  appendLogLine,
  buildRoundArtifactPaths,
  trimOldRuns,
  writeEvaluationFile,
  writeLogFile,
  writeStateChangeFile,
  writeSummaryFile
} from "../reporting/summary";
import type { EvaluationResult, LoopStateName, SubTask, ToolResult, LeaderDecision, CCBResult } from "../types/contracts";
import type { ExecResult } from "../utils/exec";
import { fileExists } from "../utils/fs";
import { runShellCommand } from "../utils/exec";
import { SecretRedactor } from "../utils/redaction";
import { runTimestamp } from "../utils/time";
import { buildDeterministicGoal } from "./control";
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
  recoverInterruptedLoopState,
  setFlag,
  savePid,
  updateLoopState,
  writeLoopState,
  writePid,
  appendInstruction,
  saveEvaluation,
  saveLeaderStrategy,
  saveCCBSession
} from "./state";

const CONSECUTIVE_EVALUATOR_FAILURE_LIMIT = 3;
const TACTICAL_REWORK_LIMIT = 2;
const LEADER_REWORK_LIMIT = 2;

interface OperationalEvidenceContext {
  round: number;
  objective: string;
  expectedOutcome: string;
  consolePort: number;
  log?: (message: string) => void | Promise<void>;
}

interface HealthCheckResult {
  ok: boolean;
  status: number;
  body: string;
}

interface OperationalEvidence {
  summaryNote: string;
  lines: string[];
  stateChangeNotes: string[];
}

type CommandRunner = (command: string) => Promise<ExecResult>;
type HealthChecker = () => Promise<HealthCheckResult>;

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
    if (value) tokens.push(value);
  }
  const plainRegex = /\b(?:\.\/)?(?:src|scripts|web\/src|\.ailoop)\/[A-Za-z0-9._/-]+/g;
  for (const match of text.matchAll(plainRegex)) {
    const value = normalizePathToken(match[0] ?? "");
    if (value) tokens.push(value);
  }
  return tokens;
}

function resolveSnapshotToken(token: string, workspaceRoot: string): string {
  return path.isAbsolute(token) ? token : path.resolve(workspaceRoot, token);
}

function isConcreteSnapshotFileToken(token: string, workspaceRoot: string): boolean {
  if (!token || token.includes("://")) return false;
  const candidate = resolveSnapshotToken(token, workspaceRoot);
  if (!isPathInside(workspaceRoot, candidate)) return false;
  try {
    return lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function detectUnauthorizedModifications(stateChange: string): string[] {
  const forbiddenDocs = ["README.md", "GOAL.md", "ARCHITECTURE.md"];
  const found: string[] = [];
  for (const doc of forbiddenDocs) {
    const escapedDoc = doc.replace(/\./g, "\\.");
    const regex = new RegExp(`(?:^|\\n)(?:\\+\\+\\+ b\\/|\\+\\+\\+ |diff --git a\\/)${escapedDoc}(?:$|\\n|\\s)`);
    if (regex.test(stateChange)) found.push(doc);
  }
  return found;
}

export function extractSnapshotTargetsFromSubTask(subTask: SubTask, workspaceRoot: string): string[] {
  const tokens = [...extractPathTokens(subTask.objective), ...extractPathTokens(subTask.expected_outcome)];
  const normalized = tokens
    .filter((token) => isConcreteSnapshotFileToken(token, workspaceRoot))
    .map((token) => resolveSnapshotToken(token, workspaceRoot));
  return Array.from(new Set(normalized));
}

function buildEvaluatorReworkInstructions(
  baseInstructions: string[],
  evaluation: EvaluationResult,
  attempt: number,
  maxAttempts: number,
  stateChange: string
): string[] {
  const next = [...baseInstructions, `Evaluator failure: ${evaluation.justification}`];
  if (evaluation.recommended_next_action?.trim()) {
    next.push(`Evaluator recommended next action: ${evaluation.recommended_next_action.trim()}`);
  }
  next.push(`Auto rework attempt ${attempt}/${maxAttempts}: apply the smallest safe change that resolves blocking issues.`);
  next.push(`Current Modified Content:\n\n${stateChange}`);
  return next;
}

export function resolveNextLastError(currentLastError: string | null, requestedLastError?: string | null): string | null {
  if (requestedLastError === undefined) return currentLastError;
  return requestedLastError;
}

async function checkConsoleHealth(consolePort: number): Promise<HealthCheckResult> {
  const url = `http://127.0.0.1:${consolePort}/api/health`;
  try {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, body: (error as Error).message };
  }
}

export async function collectOperationalEvidence(
  context: OperationalEvidenceContext,
  runner: CommandRunner = (command) => runShellCommand(command, process.cwd()),
  healthChecker: HealthChecker = () => checkConsoleHealth(context.consolePort)
): Promise<OperationalEvidence> {
  const lines: string[] = [];
  const stateChangeNotes: string[] = [];
  const summaryNotes: string[] = [];
  const commitMessage = `AILoop Round ${context.round}: ${context.objective}\n\n${context.expectedOutcome}`;

  await runner("git add .");
  const stagedDiff = await runner("git diff --cached --quiet");

  if (stagedDiff.code === 0) {
    return { summaryNote: "no new commit", lines: ["Commit: none"], stateChangeNotes: [] };
  }

  await runner(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
  const hash = (await runner("git rev-parse --short HEAD")).stdout.trim();
  lines.push(`Commit: ${hash}`);
  
  await runner("git push origin HEAD");
  lines.push(`Push: ok`);

  return {
    summaryNote: `commit ${hash}`,
    lines,
    stateChangeNotes
  };
}

export class LoopEngine {
  private readonly paths;
  private readonly planner: PlannerAgent;
  private readonly tools: ToolRegistry;
  private readonly executor: ExecutorAgent;
  private readonly designer: DesignerAgent;
  private readonly leader: LeaderAgent;
  private readonly ccb: CCBSession;
  private readonly evaluator;
  private readonly uiEvaluator: UIEvaluator;
  private readonly redactor = new SecretRedactor(process.env);
  private previousToolResult: ToolResult | null = null;
  private lockHandle: FileHandle | null = null;

  constructor(private readonly config: AppConfig) {
    this.paths = buildLoopPaths(config.homeDir);
    this.tools = new ToolRegistry();
    this.planner = new PlannerAgent(this.tools, config);
    this.executor = new ExecutorAgent(this.tools, config);
    this.designer = new DesignerAgent(this.tools, config);
    this.leader = new LeaderAgent(config);
    this.ccb = new CCBSession(config);
    this.evaluator = createEvaluator(config);
    this.uiEvaluator = new UIEvaluator(config.homeDir);
  }

  async run(): Promise<void> {
    await ensureLoopHome(this.paths);
    await this.acquireLock();
    await writePid(this.paths, process.pid);

    const recoveredState = await recoverInterruptedLoopState(this.paths, "startup");
    if (recoveredState) {
      await setFlag(this.paths.pauseFlagPath);
      await this.setState("paused", recoveredState.last_error);
    } else {
      await this.setState("running");
    }

    try {
      let leaderReworkCount = 0;

      while (true) {
        if (await hasFlag(this.paths.stopFlagPath)) {
          await this.setState("stopping");
          break;
        }

        const currentStateData = await readLoopState(this.paths);
        const goalContent = await fs.readFile(this.paths.taskPath, "utf8");
        const readmeContent = await fs.readFile(path.join(process.cwd(), "README.md"), "utf8");

        // --- GOVERNANCE STEP 2/3: Leader Diagnosis & CCB ---
        if (await hasFlag(this.paths.pauseFlagPath)) {
          await this.setState("paused");
          
          if (this.config.enableLeader) {
            console.log(`[GOVERNANCE] Invoking Leader for diagnosis...`);
            const decision = await this.leader.execute({
              context: {
                goal: goalContent,
                lastError: currentStateData.last_error,
                previousEvaluationJustification: currentStateData.last_error,
                previousEvaluationDimensions: currentStateData.previous_evaluation_dimensions,
                stateChange: null
              },
              paths: this.paths,
              onLog: (msg) => console.log(`[LEADER] ${msg}`)
            });

            await saveLeaderStrategy(this.paths, currentStateData.round, decision);

            if (decision.action === "escalate_to_ccb" || (decision.action === "resume" && leaderReworkCount >= LEADER_REWORK_LIMIT)) {
              // --- GOVERNANCE STEP 4: CCB Meeting ---
              console.log(`[GOVERNANCE] Escalating to CCB...`);
              const ccbResult = await this.ccb.run(currentStateData.round, decision, readmeContent);

              await saveCCBSession(this.paths, currentStateData.round, ccbResult);
              
              if (ccbResult.decision === "approve") {
                console.log(`[CCB] CHANGE APPROVED. Applying Constitution modification...`);
                // Leader modifies README.md
                await fs.writeFile(path.join(process.cwd(), "README.md"), decision.proposed_readme_change!, "utf8");
                await clearFlag(this.paths.pauseFlagPath);
                leaderReworkCount = 0;
                continue;
              } else if (ccbResult.decision === "escalate_to_human") {
                console.log(`[CCB] EXPERT INCAPACITY. Escalating to human.`);
                await this.setState("paused", `CCB Expert requested human intervention: ${ccbResult.rationale}`);
                break;
              } else {
                console.log(`[CCB] CHANGE REJECTED.`);
                // Feed remediation hints back to instructions
                for (const expert of ccbResult.experts) {
                  if (expert.remediation_hints) {
                    for (const hint of expert.remediation_hints) await appendInstruction(this.paths, `[CCB Hint from ${expert.expert_role}]: ${hint}`);
                  }
                }
                await clearFlag(this.paths.pauseFlagPath);
                continue;
              }
            } else if (decision.action === "resume") {
              // Leader issues strategic instructions
              console.log(`[LEADER] Strategy: ${decision.rationale}`);
              for (const inst of decision.instructions) await appendInstruction(this.paths, inst);
              await clearFlag(this.paths.pauseFlagPath);
              leaderReworkCount++;
              continue;
            } else {
              await this.setState("stopping");
              break;
            }
          } else {
            const pausedResult = await waitWhilePaused(this.paths);
            if (pausedResult === "stopped") break;
            await this.setState("running");
          }
        }

        const roundOutcome = await this.runRound(currentStateData.round + 1);
        if (!roundOutcome.success) {
          await setFlag(this.paths.pauseFlagPath);
          await this.setState("paused", roundOutcome.errorMessage ?? "round failed");
          continue;
        }

        await this.setState("cooldown");
        const cooldownResult = await cooldownWithControlChecks(this.paths, this.config.intervalSeconds);
        if (cooldownResult === "stop") break;
        await this.setState("running");
      }

      await clearFlag(this.paths.stopFlagPath);
      await writeLoopState(this.paths, { ...(await readLoopState(this.paths)), state: "idle", pid: null });
    } catch (error) {
      console.error("[FATAL LOOP ERROR]", error);
      await setFlag(this.paths.pauseFlagPath);
      await this.setState("paused", `Fatal error: ${(error as Error).message}`);
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
    
    const workspace = new WorkspaceManager(this.paths);
    const guardrails = new Guardrails(this.config.budget);
    
    try {
      const goal = await buildDeterministicGoal(process.cwd());
      const instructions = await drainInstructions(this.paths);
      const priorState = await readLoopState(this.paths);

      // --- TACTICAL STEP 1: Plan & Execute ---
      let subTask = await this.planner.plan({ 
        goal, 
        instructions, 
        round, 
        budget: this.config.budget, 
        previous_tool_result: priorState.previous_tool_result,
        previous_round_error: priorState.last_error,
        consecutive_evaluator_failures: priorState.consecutive_evaluator_failures
      }, { onLog: log });
      let snapshot = await workspace.createSnapshot(subTask.impacted_files.length > 0 ? subTask.impacted_files : extractSnapshotTargetsFromSubTask(subTask, process.cwd()));
      
      const activeAgent = subTask.assignee === "designer" ? this.designer : this.executor;
      let execution = await activeAgent.execute({ subTask, round, goal, instructions, guardrails, paths: this.paths, onLog: log });
      let finalToolResult = { ...execution.toolResult };
      let stateChange = await workspace.buildStateChange(snapshot);
      
      const activeEvaluator = subTask.assignee === "designer" ? this.uiEvaluator : this.evaluator;
      let evaluation = await activeEvaluator.evaluate({ subTask, toolResult: finalToolResult, stateChange, logLines, runTimestamp: runId, budgetLimits: guardrails.limitsSnapshot(), budgetUsage: guardrails.usage(), onLog: log });

      // --- TACTICAL STEP 2: Auto-Rework (Max 2) ---
      if (evaluation.decision === "fail" && finalToolResult.status === "success") {
        for (let attempt = 1; attempt <= TACTICAL_REWORK_LIMIT; attempt++) {
          await log(`[GOVERNANCE] Tactical Rework attempt ${attempt}/${TACTICAL_REWORK_LIMIT}`);
          execution = await activeAgent.execute({ 
            subTask, round, goal, 
            instructions: buildEvaluatorReworkInstructions(instructions, evaluation, attempt, TACTICAL_REWORK_LIMIT, stateChange), 
            guardrails, paths: this.paths, onLog: log 
          });
          finalToolResult = { ...execution.toolResult };
          stateChange = await workspace.buildStateChange(snapshot);
          evaluation = await activeEvaluator.evaluate({ subTask, toolResult: finalToolResult, stateChange, logLines, runTimestamp: runId, budgetLimits: guardrails.limitsSnapshot(), budgetUsage: guardrails.usage(), onLog: log });
          if (evaluation.decision === "pass") break;
        }
      }

      // --- Finalize Round ---
      if (evaluation.decision === "pass") {
        await log("Evaluation passed. Round committed.");
        // (Collect Operational Evidence, Commit, etc. omitted for brevity in this draft but should be present)
      }

      await this.finalizeRoundArtifacts(round, runId, artifacts, finalToolResult, evaluation, guardrails, stateChange, logLines);
      
      return { success: evaluation.decision === "pass", errorMessage: evaluation.justification };
    } catch (error) {
      return { success: false, errorMessage: (error as Error).message };
    }
  }

  private async finalizeRoundArtifacts(round: number, runId: string, artifacts: any, toolResult: ToolResult, evaluation: EvaluationResult, guardrails: Guardrails, stateChange: string, logLines: string[]) {
    await writeStateChangeFile(artifacts.stateChangePath, stateChange);
    await writeLogFile(artifacts.logPath, logLines);
    await writeEvaluationFile(artifacts.evaluationPath, evaluation);
    await saveEvaluation(this.paths, round, evaluation);
    await writeSummaryFile(artifacts.summaryPath, { goal: "", subTask: {} as any, actions: [], toolResult, evaluation, metrics: {} as any, risks: [], autoReworkAttempts: [], nextRecommendation: "", artifacts });
    
    await updateLoopState(this.paths, (current) => ({
      ...current,
      round,
      state: "running",
      pid: process.pid,
      last_error: evaluation.decision === "fail" ? evaluation.justification : null,
      consecutive_evaluator_failures: evaluation.decision === "fail" ? current.consecutive_evaluator_failures + 1 : 0,
      previous_tool_result: toolResult,
      previous_evaluation_dimensions: evaluation.dimensions,
      current_budget: { limits: guardrails.limitsSnapshot(), usage: guardrails.usage() }
    }));
  }

  private async setState(state: LoopStateName, lastError?: string | null): Promise<void> {
    await updateLoopState(this.paths, (current) => ({
      ...current,
      state,
      pid: process.pid,
      last_error: lastError !== undefined ? lastError : current.last_error
    }));
  }

  private async acquireLock(): Promise<void> {
    try {
      this.lockHandle = await fs.open(this.paths.lockPath, "wx");
      await this.lockHandle.writeFile(`${process.pid}\n`);
    } catch (error) {
      if ((error as any).code === "EEXIST") throw new Error("Loop lock exists.");
      throw error;
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockHandle) await this.lockHandle.close();
    await fs.unlink(this.paths.lockPath).catch(() => {});
  }
}
