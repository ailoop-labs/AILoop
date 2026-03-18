import fs from "node:fs/promises";
import path from "node:path";
import { lstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { AppConfig } from "../config/env";
import { ExecutorAgent } from "../agent/executor";
import { DesignerAgent } from "../agent/designer";
import { Guardrails, BudgetBreachError } from "../agent/guardrails";
import { PlannerAgent, resolvePlannerRequirementMode } from "../agent/planner";
import { LeaderAgent } from "../agent/leader";
import { ProductManagerAgent } from "../agent/product-manager";
import { buildProductManagerSourceManifest, extractRuntimePolicyBriefFromAgents } from "../agent/runtime-policy";
import { CCBSession } from "./ccb";
import { UIEvaluator } from "../evaluation/strategies/ui-evaluator";
import { ToolRegistry } from "../agent/tool-registry";
import { WorkspaceManager } from "../environment/workspace";
import { readActiveRequirementArtifact, writeActiveRequirementArtifact } from "../product/requirements";
import {
  assessRequirementCompletion,
  getRequirementLifecycleStatus,
  upsertRequirementLifecycleStatus
} from "../planning/requirement-completion";
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
import type { ActionRecord, EvaluationResult, LoopStateName, SubTask, ToolResult, LeaderDecision, CCBResult } from "../types/contracts";
import type { ExecResult } from "../utils/exec";
import { fileExists, readTextFile } from "../utils/fs";
import { runShellCommand } from "../utils/exec";
import { SecretRedactor } from "../utils/redaction";
import { runTimestamp } from "../utils/time";
import { readGoalFile, resolveWorkspaceRootFromHome } from "./goal";
import { cooldownWithControlChecks, waitWhilePaused } from "./scheduler";
import { shouldTriggerStructuralMaintenance, buildStructuralMaintenanceInstructions } from "./structural-maintenance";
import {
  buildLoopPaths,
  clearFlag,
  clearPid,
  consumeNextInstruction,
  defaultLoopState,
  ensureLoopHome,
  hasFlag,
  readLoopState,
  recoverInterruptedLoopState,
  setFlag,
  updateLoopState,
  writeLoopState,
  writePid,
  appendInstruction,
  saveEvaluation,
  saveLeaderStrategy,
  saveCCBSession
} from "./state";

const LEADER_REWORK_LIMIT = 2;
const STRATEGIC_EVALUATOR_BLOCK_PREFIX = "EvaluatorStrategicBlock:";

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

function summarizeRequirementArtifact(markdown: string | null): string | null {
  if (!markdown?.trim()) {
    return null;
  }

  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .slice(0, 240);
}

function resolveRequirementArtifactStatus(markdown: string | null): "missing" | "ready" | "needs_refresh" {
  if (!markdown?.trim()) {
    return "missing";
  }

  return getRequirementLifecycleStatus(markdown) === "complete" ? "needs_refresh" : "ready";
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
    if (value) tokens.push(value);
  }
  const plainRegex = /\b(?:\.\/)?(?:src|scripts|web\/src|\.ailoop)\/[A-Za-z0-9._/-]+/g;
  for (const match of text.matchAll(plainRegex)) {
    const value = normalizePathToken(match[0] ?? "");
    if (value) tokens.push(value);
  }
  return tokens;
}

function subTaskRequestsRequirementArtifact(subTask: SubTask): boolean {
  if (subTask.impacted_files.includes(".ailoop/product-requirements/current.md")) {
    return true;
  }

  const combined = `${subTask.objective} ${subTask.expected_outcome}`.toLowerCase();
  return combined.includes(".ailoop/product-requirements/current.md") && combined.includes("productmanager")
    ? true
    : combined.includes(".ailoop/product-requirements/current.md") && combined.includes("product manager");
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

export function buildEvaluatorReworkInstructions(
  baseInstructions: string[],
  evaluation: EvaluationResult,
  attempt: number,
  maxAttempts: number,
  _stateChange: string,
  artifactRefs?: { logPath?: string; stateChangePath?: string }
): string[] {
  const next = [...baseInstructions, `Evaluator failure: ${evaluation.justification}`];
  if (evaluation.recommended_next_action?.trim()) {
    next.push(`Evaluator recommended next action: ${evaluation.recommended_next_action.trim()}`);
  }
  next.push(`Auto rework attempt ${attempt}/${maxAttempts}: apply the smallest safe change that resolves blocking issues.`);
  if (evaluation.dimensions && evaluation.dimensions.length > 0) {
    const blockingDimensions = evaluation.dimensions
      .filter((dimension) => dimension.decision !== "pass")
      .slice(0, 3)
      .map((dimension) => `${dimension.dimension}: ${dimension.justification}`);
    if (blockingDimensions.length > 0) {
      next.push(`Evaluator dimensions to address: ${blockingDimensions.join(" | ")}`);
    }
  }
  if (artifactRefs?.stateChangePath) {
    next.push(`Review state change artifact if needed: ${artifactRefs.stateChangePath}`);
  }
  if (artifactRefs?.logPath) {
    next.push(`Review round log if needed: ${artifactRefs.logPath}`);
  }
  return next;
}

export function decideEvaluationFailureRecoveryPath(
  evaluation: EvaluationResult,
  toolResult: ToolResult
): "auto_rework" | "leader" {
  if (evaluation.decision !== "fail") {
    return "auto_rework";
  }

  if (evaluation.recovery_path === "strategic_governance") {
    return "leader";
  }

  if (evaluation.recovery_path === "tactical_rework") {
    return "auto_rework";
  }

  if (toolResult.status !== "success") {
    return "auto_rework";
  }

  const rootCause = evaluation.root_cause?.trim().toLowerCase() ?? "";
  if (rootCause.startsWith("insufficient_evidence:") || rootCause.startsWith("evaluator_infrastructure:")) {
    return "leader";
  }

  const text = [
    evaluation.justification,
    evaluation.recommended_next_action,
    ...(evaluation.evidence ?? []),
    ...(evaluation.dimensions ?? []).flatMap((dimension) => [
      dimension.justification,
      dimension.recommended_next_action,
      ...(dimension.evidence ?? []),
      ...(dimension.blocking_issues ?? [])
    ])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  const hasKeyUnknownDimension = (evaluation.dimensions ?? []).some(
    (dimension) =>
      (dimension.dimension === "goal_alignment" ||
        dimension.dimension === "causal_validity" ||
        dimension.dimension === "constraint_compliance") &&
      dimension.decision === "unknown"
  );

  const looksLikeEvidenceHandoffFailure =
    /insufficient evidence/.test(text) ||
    /no explicit validation summary/.test(text) ||
    /no behavioral verification excerpt/.test(text) ||
    /targeted excerpt/.test(text) ||
    /compact evidence/.test(text) ||
    /validation evidence is missing/.test(text) ||
    /attach minimal proof/.test(text);

  if (hasKeyUnknownDimension || looksLikeEvidenceHandoffFailure) {
    return "leader";
  }

  return "auto_rework";
}

function formatEvaluationFailurePauseMessage(evaluation: EvaluationResult): string {
  if (decideEvaluationFailureRecoveryPath(evaluation, { status: "success", summary: "", artifacts: { log_path: "", state_change_path: "" } }) === "leader") {
    return `${STRATEGIC_EVALUATOR_BLOCK_PREFIX} ${evaluation.justification}`;
  }

  return evaluation.justification;
}

export function resolveNextLastError(currentLastError: string | null, requestedLastError?: string | null): string | null {
  if (requestedLastError === undefined) return currentLastError;
  return requestedLastError;
}

export function summarizeGovernanceFailureForState(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Governance execution failed";
  }

  const diagnosticsMatch = normalized.match(/\|\s*diagnostics:\s*([^|]+)$/i);
  const diagnosticsPath = diagnosticsMatch?.[1]?.trim() ?? null;
  const base = normalized.split(/\s+\|\s+(?:stderr|raw|diagnostics):/i)[0]?.trim() || normalized;
  const detailMarkers = [
    "429 too many requests",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "timed out",
    "schema mismatch",
    "not valid json",
    "too many requests"
  ];
  const lower = normalized.toLowerCase();
  const detail = detailMarkers.find((marker) => lower.includes(marker)) ?? null;

  const segments = [base];
  if (detail && !base.toLowerCase().includes(detail)) {
    segments.push(`detail: ${detail}`);
  }
  if (diagnosticsPath) {
    segments.push(`diagnostics: ${diagnosticsPath}`);
  }

  return segments.join(" | ");
}

function withConcreteArtifactPaths(
  toolResult: ToolResult,
  artifacts: { logPath: string; stateChangePath: string }
): ToolResult {
  return {
    ...toolResult,
    artifacts: {
      ...toolResult.artifacts,
      log_path: artifacts.logPath,
      state_change_path: artifacts.stateChangePath
    }
  };
}

function withOperationalEvidence(toolResult: ToolResult, evidence: OperationalEvidence): ToolResult {
  const summaryNote = evidence.summaryNote.trim();
  const nextSummary = summaryNote
    ? `${toolResult.summary} | Operational follow-up: ${summaryNote}`
    : toolResult.summary;
  const nextEvidence = evidence.lines.length > 0
    ? [...(toolResult.operational_evidence ?? []), ...evidence.lines]
    : toolResult.operational_evidence;

  return {
    ...toolResult,
    summary: nextSummary,
    operational_evidence: nextEvidence
  };
}

function withPriorSuccessfulExecution(toolResult: ToolResult, priorSuccessfulSummary: string): ToolResult {
  if (toolResult.status !== "failure") {
    return toolResult;
  }

  return {
    ...toolResult,
    summary: [
      "Initial executor pass succeeded before later rework/governance failure.",
      `Initial success: ${priorSuccessfulSummary}`,
      `Final failure: ${toolResult.summary}`
    ].join(" "),
    operational_evidence: [
      ...(toolResult.operational_evidence ?? []),
      `Initial executor pass succeeded before rework failure: ${priorSuccessfulSummary}`
    ]
  };
}

function buildSummaryActionsWithPriorSuccess(
  successfulActions: ActionRecord[],
  failureMessage: string
): ActionRecord[] {
  return [
    ...successfulActions,
    {
      tool: "governance",
      args: { phase: "auto_rework" },
      status: "failure",
      ok: false,
      output: "Later tactical rework/governance step failed after an earlier successful executor pass.",
      error: failureMessage
    }
  ];
}

function appendNotesToStateChange(stateChange: string, heading: string, notes: string[]): string {
  if (notes.length === 0) return stateChange;
  const trimmed = stateChange.trimEnd();
  const prefix = trimmed ? `${trimmed}\n\n` : "";
  return `${prefix}### ${heading}\n${notes.join("\n")}\n`;
}

function appendOperationalEvidenceToStateChange(stateChange: string, notes: string[]): string {
  return appendNotesToStateChange(stateChange, "Operational Follow-up", notes);
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
  const normalizeCommandOutput = (result: ExecResult): string => {
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return text ? text.replace(/\s+/g, " ") : `exit ${result.code}`;
  };
  const parseRestartDetails = (output: string): { pid: string | null; logPath: string | null } => {
    const pidMatch = output.match(/PID:\s*([^\s]+)/);
    const logMatch = output.match(/Log:\s*(.+)/);
    return {
      pid: pidMatch?.[1] ?? null,
      logPath: logMatch?.[1]?.trim() ?? null
    };
  };
  const logStep = async (message: string): Promise<void> => {
    if (context.log) {
      await context.log(message);
    }
  };
  const lines: string[] = [];
  const stateChangeNotes: string[] = [];
  const summaryNotes: string[] = [];
  const commitMessage = `AILoop Round ${context.round}: ${context.objective}\n\n${context.expectedOutcome}`;

  await logStep("Collecting post-pass operational evidence.");
  await runner("git add .");
  const stagedDiff = await runner("git diff --cached --quiet");

  if (stagedDiff.code === 0) {
    return { summaryNote: "no new commit", lines: ["Commit: none"], stateChangeNotes: [] };
  }

  const commitResult = await runner(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
  const hash = (await runner("git rev-parse --short HEAD")).stdout.trim();
  const subject = (await runner("git log -1 --pretty=%s")).stdout.trim();
  const commitOutput = normalizeCommandOutput(commitResult);
  summaryNotes.push(`commit ${hash}`);
  lines.push(`Commit: ${hash}${subject ? ` ${subject}` : ""}`);
  stateChangeNotes.push(`Shell: git commit -m ... -> ${commitResult.code === 0 ? "ok" : `failed (${commitOutput})`}`);

  const pushResult = await runner("git push origin HEAD");
  const pushOutput = normalizeCommandOutput(pushResult);
  summaryNotes.push(pushResult.code === 0 ? "push ok" : "push failed");
  lines.push(`Push: ${pushOutput}`);
  stateChangeNotes.push(`Shell: git push origin HEAD -> ${pushResult.code === 0 ? "ok" : "failed"} (${pushOutput})`);

  const restartResult = await runner("bash scripts/prod.sh restart");
  const restartOutput = normalizeCommandOutput(restartResult);
  const restartDetails = parseRestartDetails(restartOutput);
  summaryNotes.push(restartResult.code === 0 ? "restart ok" : "restart failed");
  if (restartDetails.pid && restartDetails.logPath) {
    lines.push(`Restart: PID ${restartDetails.pid}, log ${restartDetails.logPath}`);
  } else {
    lines.push(`Restart: ${restartOutput}`);
  }
  stateChangeNotes.push(
    `Shell: bash scripts/prod.sh restart -> ${restartResult.code === 0 ? "ok" : "failed"} (${restartOutput})`
  );

  const health = await healthChecker();
  summaryNotes.push(health.ok ? "health check ok" : "health check failed");
  lines.push(`Health Check: GET /api/health -> ${health.status} ${health.ok ? "OK" : "FAIL"}`);
  stateChangeNotes.push(
    `Health: GET /api/health -> ${health.status} ${health.ok ? "ok" : "failed"} (${health.body.trim() || "no body"})`
  );

  lines.push(`Rollback: git revert --no-edit ${hash} && bash scripts/prod.sh restart`);
  await logStep(`Operational evidence collected for commit ${hash}.`);

  return {
    summaryNote: summaryNotes.join(", "),
    lines,
    stateChangeNotes
  };
}

async function readLeaderStateChangeEvidence(toolResult: ToolResult | null | undefined): Promise<string | null> {
  const stateChangePath = toolResult?.artifacts.state_change_path?.trim();
  if (!stateChangePath) {
    return null;
  }

  const content = await readTextFile(stateChangePath, "");
  const normalized = content.trim();
  return normalized ? normalized : null;
}

export class LoopEngine {
  private readonly paths;
  private readonly planner: PlannerAgent;
  private readonly productManager: ProductManagerAgent;
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
    this.productManager = new ProductManagerAgent(config);
    this.executor = new ExecutorAgent(this.tools, config);
    this.designer = new DesignerAgent(this.tools, config);
    this.leader = new LeaderAgent(config);
    this.ccb = new CCBSession(config);
    this.evaluator = createEvaluator(config);
    this.uiEvaluator = new UIEvaluator(config.homeDir);
  }

  async collectOperationalEvidence(context: Omit<OperationalEvidenceContext, "consolePort"> & { consolePort?: number }): Promise<OperationalEvidence> {
    return collectOperationalEvidence({
      ...context,
      consolePort: context.consolePort ?? this.config.consolePort
    });
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

        // --- STRUCTURAL MAINTENANCE PASS ---
        // If the evaluator recommended a structural-maintenance pass, execute it before normal governance
        if (
          await hasFlag(this.paths.pauseFlagPath) &&
          shouldTriggerStructuralMaintenance(currentStateData.previous_hot_file_governance)
        ) {
          console.log(`[STRUCTURAL MAINTENANCE] Detected hot-file governance recommendation for structural split.`);
          console.log(`[STRUCTURAL MAINTENANCE] File: ${currentStateData.previous_hot_file_governance!.file_path}`);

          // Clear pause flag to allow the structural-maintenance round to execute
          await clearFlag(this.paths.pauseFlagPath);

          // Inject structural-maintenance instructions
          const baseInstructions = await consumeNextInstruction(this.paths);
          const maintenanceInstructions = buildStructuralMaintenanceInstructions(
            currentStateData.previous_hot_file_governance!,
            baseInstructions
          );

          for (const instruction of maintenanceInstructions) {
            await appendInstruction(this.paths, instruction);
          }

          // Clear hot-file governance state to prevent re-triggering
          await updateLoopState(this.paths, (current) => ({
            ...current,
            previous_hot_file_governance: null,
            last_error: null
          }));

          console.log(`[STRUCTURAL MAINTENANCE] Structural-maintenance instructions injected. Proceeding to execute refactoring round.`);

          // Continue to execute the structural-maintenance round
          const roundOutcome = await this.runRound(currentStateData.round + 1);
          if (!roundOutcome.success) {
            await setFlag(this.paths.pauseFlagPath);
            await this.setState("paused", roundOutcome.errorMessage ?? "structural-maintenance round failed");
            continue;
          }

          console.log(`[STRUCTURAL MAINTENANCE] Structural-maintenance round completed successfully.`);
          await this.setState("cooldown");
          const cooldownResult = await cooldownWithControlChecks(this.paths, this.config.intervalSeconds);
          if (cooldownResult === "stop") break;
          await this.setState("running");
          continue;
        }

        // --- GOVERNANCE STEP 2/3: Leader Diagnosis & CCB ---
        if (await hasFlag(this.paths.pauseFlagPath)) {
          await this.setState("paused");

          // Check stop flag before invoking Leader to allow immediate shutdown
          if (await hasFlag(this.paths.stopFlagPath)) {
            await this.setState("stopping");
            break;
          }

          console.log(`[GOVERNANCE] Invoking Leader for diagnosis...`);
          try {
            // Create a stop flag checker that runs in parallel with Leader execution
            const stopFlagChecker = (async () => {
              while (true) {
                if (await hasFlag(this.paths.stopFlagPath)) {
                  throw new Error("STOP_REQUESTED");
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            })();

            const leaderExecution = this.leader.execute({
              context: {
                goal: goalContent,
                lastError: currentStateData.last_error,
                previousEvaluationJustification: currentStateData.last_error,
                previousToolResult: currentStateData.previous_tool_result,
                previousEvaluationDimensions: currentStateData.previous_evaluation_dimensions,
                previousHotFileGovernance: currentStateData.previous_hot_file_governance,
                stateChange: await readLeaderStateChangeEvidence(currentStateData.previous_tool_result)
              },
              paths: this.paths,
              onLog: (msg) => console.log(`[LEADER] ${msg}`)
            });

            const decision = await Promise.race([leaderExecution, stopFlagChecker]);

            await saveLeaderStrategy(this.paths, currentStateData.round, decision);

            // Check stop flag AGAIN after leader execution as it might take time
            if (await hasFlag(this.paths.stopFlagPath)) {
              await this.setState("stopping");
              break;
            }

            if (decision.action === "escalate_to_ccb" || (decision.action === "resume" && leaderReworkCount >= LEADER_REWORK_LIMIT)) {
              // --- GOVERNANCE STEP 4: CCB Meeting ---
              console.log(`[GOVERNANCE] Escalating to CCB...`);

              // Create a stop flag checker that runs in parallel with CCB execution
              const ccbStopFlagChecker = (async () => {
                while (true) {
                  if (await hasFlag(this.paths.stopFlagPath)) {
                    throw new Error("STOP_REQUESTED");
                  }
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              })();

              const ccbExecution = this.ccb.run(currentStateData.round, decision, readmeContent);
              const ccbResult = await Promise.race([ccbExecution, ccbStopFlagChecker]);

              await saveCCBSession(this.paths, currentStateData.round, ccbResult);

              // Check stop flag after CCB execution as it might take time
              if (await hasFlag(this.paths.stopFlagPath)) {
                await this.setState("stopping");
                break;
              }

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
          } catch (err) {
            const errorMessage = (err as Error).message;

            // Check if stop was requested during Leader execution
            if (errorMessage === "STOP_REQUESTED") {
              console.log(`[GOVERNANCE] Stop requested during Leader execution. Exiting cleanly.`);
              await this.setState("stopping");
              break;
            }

            console.error(`[GOVERNANCE] Error during Leader/CCB execution:`, err);

            // Check if this is a network/upstream error (502, 503, timeout, etc.)
            // For these errors, we should exit cleanly and let the operator restart
            // rather than holding the lock indefinitely in waitWhilePaused
            const isNetworkError = errorMessage.includes("502 Bad Gateway") ||
                                   errorMessage.includes("503 Service Unavailable") ||
                                   errorMessage.includes("Upstream request failed") ||
                                   errorMessage.includes("ECONNREFUSED") ||
                                   errorMessage.includes("ETIMEDOUT");

            if (isNetworkError) {
              await this.setState("paused", `Governance failed due to network error: ${summarizeGovernanceFailureForState(errorMessage)}. Please check network connectivity and restart.`);
              console.log(`[GOVERNANCE] Network error detected. Exiting to release lock. Operator should restart when network is stable.`);
              break;
            }

            // For other errors, pause and wait for operator intervention
            await this.setState("paused", `Governance failed: ${summarizeGovernanceFailureForState(errorMessage)}`);
            const pausedResult = await waitWhilePaused(this.paths);
            if (pausedResult === "stopped") break;
            await this.setState("running");
            continue;
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
    
    const phaseTimings: RoundPhaseTimings = {
      planning: 0,
      execution: 0,
      evaluation: 0,
      operational_followup: 0
    };
    const autoReworkNotes: string[] = [];
    const logLines: string[] = [];
    const log = async (message: string): Promise<void> => {
      const ts = new Date().toISOString().slice(11, 19);
      const line = `[${ts}]${this.redactor.redact(message)}`;
      logLines.push(line);
      await appendLogLine(artifacts.logPath, line);
    };
    await writeLogFile(artifacts.logPath, []);
    
    const workspace = new WorkspaceManager(this.paths);
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
      assignee: "executor",
      rationale: "Round initialization",
      objective: "Initialize round context",
      expected_outcome: "Context initialized",
      impacted_files: [],
      recommended_tools: []
    };
    let stateChange = "No state changes detected.\n";
    let snapshot: any = null;
    let goal = await readGoalFile(this.paths.taskPath, resolveWorkspaceRootFromHome(this.paths.homeDir));

    try {
      await enforceBudgetBeforeAction("round.bootstrap");
      const instructions = await consumeNextInstruction(this.paths);
      const priorState = await readLoopState(this.paths);
      const tacticalReworkLimit = Math.max(0, this.config.evaluatorReworkMaxAttempts);
      let requirementMarkdown = await readActiveRequirementArtifact(this.paths);

      // --- TACTICAL STEP 1: Plan & Execute ---
      const planWithRequirements = async (currentRequirementMarkdown: string | null): Promise<SubTask> => {
        const plannerContext = {
          goal,
          instructions,
          round,
          budget: this.config.budget,
          previous_tool_result: priorState.previous_tool_result,
          previous_round_error: priorState.last_error,
          consecutive_evaluator_failures: priorState.consecutive_evaluator_failures,
          requirement_artifact_status: resolveRequirementArtifactStatus(currentRequirementMarkdown),
          requirement_artifact_summary: summarizeRequirementArtifact(currentRequirementMarkdown)
        } as const;

        await enforceBudgetBeforeAction("planner.plan");
        const planned = await this.planner.plan(plannerContext, { onLog: log });

        if (
          resolvePlannerRequirementMode(plannerContext) === "normal_execution" ||
          !subTaskRequestsRequirementArtifact(planned)
        ) {
          return planned;
        }

        await enforceBudgetBeforeAction("productManager.generateRequirement");
        const agentsGuide = await readTextFile(path.join(process.cwd(), "AGENTS.md"), "");
        const generatedRequirement = await this.productManager.generateRequirement(
          {
            goal,
            instructions,
            round,
            current_requirement_markdown: currentRequirementMarkdown,
            previous_tool_result: priorState.previous_tool_result,
            previous_round_error: priorState.last_error,
            runtime_policy_brief: extractRuntimePolicyBriefFromAgents(agentsGuide),
            source_manifest: buildProductManagerSourceManifest({
              includeCurrentRequirement: Boolean(currentRequirementMarkdown?.trim())
            })
          },
          { onLog: log }
        );
        await writeActiveRequirementArtifact(this.paths, generatedRequirement);
        requirementMarkdown = await readActiveRequirementArtifact(this.paths);
        await log("ProductManager refreshed the active requirement artifact.");

        const refreshedPlannerContext = {
          ...plannerContext,
          requirement_artifact_status: "ready" as const,
          requirement_artifact_summary: summarizeRequirementArtifact(requirementMarkdown)
        };
        await enforceBudgetBeforeAction("planner.plan after productManager");
        return this.planner.plan(refreshedPlannerContext, { onLog: log });
      };

      const planningStartedAt = Date.now();
      subTask = await planWithRequirements(requirementMarkdown);
      phaseTimings.planning += Date.now() - planningStartedAt;
      snapshot = await workspace.createSnapshot(subTask.impacted_files.length > 0 ? subTask.impacted_files : extractSnapshotTargetsFromSubTask(subTask, process.cwd()));
      
      const activeAgent = subTask.assignee === "designer" ? this.designer : this.executor;
      const executionStartedAt = Date.now();
      await enforceBudgetBeforeAction(`executor.execute`);
      let execution = await activeAgent.execute({ subTask, round, goal, instructions, guardrails, paths: this.paths, onLog: log });
      phaseTimings.execution += Date.now() - executionStartedAt;
      let finalToolResult = withConcreteArtifactPaths(execution.toolResult, artifacts);
      let summaryActions = execution.actions;
      let lastSuccessfulExecution =
        finalToolResult.status === "success"
          ? {
              actions: execution.actions,
              toolResult: finalToolResult
            }
          : null;
      stateChange = await workspace.buildStateChange(snapshot);
      
      const activeEvaluator = subTask.assignee === "designer" ? this.uiEvaluator : this.evaluator;
      const evaluationStartedAt = Date.now();
      await enforceBudgetBeforeAction(`evaluator.evaluate`);
      await writeStateChangeFile(artifacts.stateChangePath, stateChange);
      let evaluation = await activeEvaluator.evaluate({ subTask, toolResult: finalToolResult, stateChange, logLines, runTimestamp: runId, budgetLimits: guardrails.limitsSnapshot(), budgetUsage: guardrails.usage(), onLog: log });
      phaseTimings.evaluation += Date.now() - evaluationStartedAt;
      let autoReworkAttempts = 0;
      const failureRecoveryPath = decideEvaluationFailureRecoveryPath(evaluation, finalToolResult);

      // --- TACTICAL STEP 2: Auto-Rework (Max 2) ---
      if (evaluation.decision === "fail" && finalToolResult.status === "success" && failureRecoveryPath === "auto_rework") {
        for (let attempt = 1; attempt <= tacticalReworkLimit; attempt++) {
          autoReworkAttempts = attempt;
          await log(`[GOVERNANCE] Tactical Rework attempt ${attempt}/${tacticalReworkLimit}`);
          const priorJustification = evaluation.justification;
          const reworkExecutionStartedAt = Date.now();
          await enforceBudgetBeforeAction(`executor.execute auto-rework ${attempt}`);
          execution = await activeAgent.execute({
            subTask, round, goal,
            instructions: buildEvaluatorReworkInstructions(
              instructions,
              evaluation,
              attempt,
              tacticalReworkLimit,
              stateChange,
              {
                logPath: artifacts.logPath,
                stateChangePath: artifacts.stateChangePath
              }
            ),
            guardrails, paths: this.paths, onLog: log
          });
          phaseTimings.execution += Date.now() - reworkExecutionStartedAt;
          finalToolResult = withConcreteArtifactPaths(execution.toolResult, artifacts);
          if (finalToolResult.status === "success") {
            lastSuccessfulExecution = {
              actions: execution.actions,
              toolResult: finalToolResult
            };
            summaryActions = execution.actions;
          }
          stateChange = await workspace.buildStateChange(snapshot);
          const reworkEvaluationStartedAt = Date.now();
          await enforceBudgetBeforeAction(`evaluator.evaluate auto-rework ${attempt}`);
          await writeStateChangeFile(artifacts.stateChangePath, stateChange);
          evaluation = await activeEvaluator.evaluate({ subTask, toolResult: finalToolResult, stateChange, logLines, runTimestamp: runId, budgetLimits: guardrails.limitsSnapshot(), budgetUsage: guardrails.usage(), onLog: log });
          phaseTimings.evaluation += Date.now() - reworkEvaluationStartedAt;
          autoReworkNotes.push(
            `Attempt ${attempt}/${tacticalReworkLimit}: trigger='${priorJustification}' evaluation=${evaluation.decision}`
          );
          if (evaluation.decision === "pass") break;
        }
      } else if (evaluation.decision === "fail" && failureRecoveryPath === "leader") {
        await log("[GOVERNANCE] Routing evaluator failure directly to Leader (strategic recovery required).");
      }

      if (finalToolResult.status === "failure" && lastSuccessfulExecution) {
        finalToolResult = withPriorSuccessfulExecution(
          finalToolResult,
          lastSuccessfulExecution.toolResult.summary
        );
        summaryActions = buildSummaryActionsWithPriorSuccess(
          lastSuccessfulExecution.actions,
          finalToolResult.error?.message ?? "rework/governance failure"
        );
      }

      // --- Finalize Round ---
      if (evaluation.decision === "pass") {
        await log("Evaluation passed. Round committed.");
        const operationalFollowupStartedAt = Date.now();
        await enforceBudgetBeforeAction("engine.collectOperationalEvidence");
        const operationalEvidence = await this.collectOperationalEvidence({
          round,
          objective: subTask.objective,
          expectedOutcome: subTask.expected_outcome,
          log
        });
        phaseTimings.operational_followup += Date.now() - operationalFollowupStartedAt;
        finalToolResult = withOperationalEvidence(finalToolResult, operationalEvidence);
        stateChange = appendOperationalEvidenceToStateChange(stateChange, operationalEvidence.stateChangeNotes);
        if (operationalEvidence.summaryNote.trim()) {
          await log(`Operational follow-up: ${operationalEvidence.summaryNote}`);
        }
      }

      if (evaluation.decision === "pass") {
        requirementMarkdown = await readActiveRequirementArtifact(this.paths);
      }

      if (evaluation.decision === "pass" && requirementMarkdown?.trim()) {
        const completion = assessRequirementCompletion({
          requirementMarkdown,
          evaluation,
          toolResult: finalToolResult,
          stateChange
        });

        if (completion.isComplete) {
          requirementMarkdown = upsertRequirementLifecycleStatus(requirementMarkdown, completion, round);
          await writeActiveRequirementArtifact(this.paths, requirementMarkdown);
          stateChange = appendNotesToStateChange(stateChange, "Requirement Lifecycle", [
            `Requirement: marked .ailoop/product-requirements/current.md as complete for round ${round}.`,
            `Requirement: matched acceptance criteria ${completion.matchedCriteria.length}/${completion.matchedCriteria.length + completion.unmatchedCriteria.length}.`
          ]);
          await log("Requirement slice marked complete.");

          if (finalToolResult.next_state_hint === "stop") {
            await setFlag(this.paths.stopFlagPath);
            await log("Executor requested stop after completing the active requirement slice.");
          }
        }
      }

      const metrics: RoundMetrics = {
        round,
        run_timestamp: runId,
        duration_ms: Date.now() - startedAt,
        budget_limits: guardrails.limitsSnapshot(),
        budget_usage: guardrails.usage(),
        evaluator_decision: evaluation.decision,
        tool_status: finalToolResult.status,
        retries: {
          evidence_remediation_attempts: 0,
          auto_rework_attempts: autoReworkAttempts,
          auto_rework_limit: this.config.evaluatorReworkMaxAttempts
        },
        phase_timings_ms: phaseTimings
      };

      await this.finalizeRoundArtifacts(
        round,
        artifacts,
        goal,
        subTask,
        summaryActions,
        finalToolResult,
        evaluation,
        metrics,
        stateChange,
        logLines,
        autoReworkNotes
      );
      
      return {
        success: evaluation.decision === "pass",
        errorMessage: evaluation.decision === "fail" ? formatEvaluationFailurePauseMessage(evaluation) : evaluation.justification
      };
    } catch (error) {
      const message = error instanceof BudgetBreachError ? error.message : (error as Error).message;
      const errorType = error instanceof BudgetBreachError ? "BudgetBreach" : "RoundExecutionError";
      let failureMessage = message;
      let rollbackRecordedPause = error instanceof BudgetBreachError;
      const failureToolResult: ToolResult = {
        status: "failure",
        summary: "Round failed before evaluation completed.",
        artifacts: {
          log_path: artifacts.logPath,
          state_change_path: artifacts.stateChangePath
        },
        error: {
          type: errorType,
          message: failureMessage
        },
        next_state_hint: rollbackRecordedPause ? "pause" : "continue"
      };

      if (snapshot) {
        try {
          await workspace.rollback(snapshot);
          stateChange = `${stateChange}\nRollback: workspace snapshot restored after round error.\n`;
        } catch (rollbackError) {
          const rollbackMessage = (rollbackError as Error).message;
          failureMessage = `${message} | Rollback failed after round error: ${rollbackMessage}`;
          rollbackRecordedPause = true;
          failureToolResult.error = {
            type: errorType,
            message: failureMessage
          };
          failureToolResult.next_state_hint = "pause";
          stateChange = `${stateChange}\nRollback: failed to restore workspace snapshot after round error (${rollbackMessage}).\n`;
        }
      } else {
        stateChange = `${stateChange}\nRollback: not needed because no workspace snapshot was captured before the round error.\n`;
      }

      const usage = guardrails.usage();
      const metrics: RoundMetrics = {
        round,
        run_timestamp: runId,
        duration_ms: Date.now() - startedAt,
        budget_limits: guardrails.limitsSnapshot(),
        budget_usage: usage,
        evaluator_decision: "fail",
        tool_status: "failure",
        retries: {
          evidence_remediation_attempts: 0,
          auto_rework_attempts: 0,
          auto_rework_limit: this.config.evaluatorReworkMaxAttempts
        },
        phase_timings_ms: phaseTimings
      };

      await writeStateChangeFile(artifacts.stateChangePath, stateChange);
      await log(`Round error: ${message}`);
      await writeLogFile(artifacts.logPath, logLines);
      await writeMetricsFile(artifacts.metricsPath, metrics);
      await writeSummaryFile(artifacts.summaryPath, {
        goal,
        subTask,
        actions: [],
        toolResult: failureToolResult,
        evaluation: {
          decision: "fail",
          justification: failureMessage,
          evidence: [failureMessage],
          recommended_next_action: "pause and inspect round error"
        },
        metrics,
        stateChange,
        risks: [failureMessage],
        autoReworkAttempts: [],
        nextRecommendation: rollbackRecordedPause ? "pause" : "continue",
        artifacts: {
          logPath: artifacts.logPath,
          summaryPath: artifacts.summaryPath,
          metricsPath: artifacts.metricsPath,
          stateChangePath: artifacts.stateChangePath,
          evaluationPath: artifacts.evaluationPath
        }
      });

      if (rollbackRecordedPause) {
        await setFlag(this.paths.pauseFlagPath);
      }

      const nextState = rollbackRecordedPause ? "paused" : "running";

      await updateLoopState(this.paths, (current) => ({
        ...current,
        round,
        state: nextState,
        pid: process.pid,
        last_error: failureMessage,
        consecutive_evaluator_failures: current.consecutive_evaluator_failures,
        previous_tool_result: failureToolResult,
        previous_hot_file_governance: null,
        current_budget: {
          limits: guardrails.limitsSnapshot(),
          usage
        }
      }));

      return { success: false, errorMessage: failureMessage };
    }
  }

  private async finalizeRoundArtifacts(
    round: number,
    artifacts: {
      logPath: string;
      summaryPath: string;
      metricsPath: string;
      stateChangePath: string;
      evaluationPath: string;
    },
    goal: string,
    subTask: SubTask,
    actions: ActionRecord[],
    toolResult: ToolResult,
    evaluation: EvaluationResult,
    metrics: RoundMetrics,
    stateChange: string,
    logLines: string[],
    autoReworkAttempts: string[]
  ) {
    await writeStateChangeFile(artifacts.stateChangePath, stateChange);
    await writeLogFile(artifacts.logPath, logLines);
    await writeEvaluationFile(artifacts.evaluationPath, evaluation);
    await writeMetricsFile(artifacts.metricsPath, metrics);
    await saveEvaluation(this.paths, round, evaluation);
    await writeSummaryFile(artifacts.summaryPath, {
      goal,
      subTask,
      actions,
      toolResult,
      evaluation,
      metrics,
      stateChange,
      risks: [],
      autoReworkAttempts,
      nextRecommendation: evaluation.recommended_next_action ?? "",
      artifacts
    });
    
    await updateLoopState(this.paths, (current) => ({
      ...current,
      round,
      state: "running",
      pid: process.pid,
      last_error: evaluation.decision === "fail" ? evaluation.justification : null,
      consecutive_evaluator_failures: evaluation.decision === "fail" ? current.consecutive_evaluator_failures + 1 : 0,
      previous_tool_result: toolResult,
      previous_evaluation_dimensions: evaluation.dimensions,
      previous_hot_file_governance: evaluation.hot_file_governance ?? null,
      current_budget: { limits: metrics.budget_limits, usage: metrics.budget_usage }
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
