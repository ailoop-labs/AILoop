import { useEffect, useMemo, useState } from "react";
import { LazyLog, ScrollFollow } from "@melloware/react-logviewer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildLogViewerText } from "./log-lines";
import { resolveLogTailFollowBehavior } from "./log-follow";
import { GoalMarkdown } from "./goal-markdown";
import { deriveRoundProgress } from "./round-progress";
import { RequirementSnapshotCard, type RequirementArtifactView } from "./requirement-snapshot";
import {
  projectRunHistoryReport,
  type RunArtifactPresence,
  type RunHistoryItem,
  type GovernanceDetails,
  type ExpertOpinion,
  type HotFileGovernanceResult,
  type RoundReport
} from "./run-history";
import { paginateRunHistory, RUN_HISTORY_PAGE_SIZE } from "./run-history-pagination";

type LoopStateName = "idle" | "starting" | "running" | "cooldown" | "paused" | "stopping" | "error";
type BudgetDimension = "cost" | "time" | "actions";
type BudgetHealth = "healthy" | "warning" | "breached";
type CliProvider = "codex" | "claude";

interface LoopStatus {
  state: LoopStateName;
  round: number;
  pid: number | null;
  pid_alive: boolean;
  pending_instruction_count: number;
  pause_reason: string | null;
  hot_file_governance: HotFileGovernanceResult | null;
  crash_recovery: CrashRecoveryStatus | null;
  operator_reason: OperatorStatusReason | null;
  artifact_completeness: ArtifactCompletenessStatus;
  last_error: string | null;
  updated_at: string;
  consecutive_evaluator_failures: number;
  budget_health: BudgetHealthStatus | null;
  current_budget: {
    limits: {
      usdPerRound: number;
      timeMinutes: number;
      actions: number;
    };
    usage: {
      usdUsed: number;
      elapsedMs: number;
      actionsUsed: number;
    };
  } | null;
  active_requirement: RequirementArtifactView;
}

interface BudgetDimensionHealth {
  dimension: BudgetDimension;
  label: string;
  health: BudgetHealth;
  used: number;
  limit: number;
  ratio: number;
}

interface BudgetHealthStatus {
  overall: BudgetHealth;
  breached_dimension: BudgetDimension | null;
  dimensions: BudgetDimensionHealth[];
}

interface OperatorStatusReason {
  kind:
    | "manual_pause_requested"
    | "manual_pause"
    | "budget_breach"
    | "hot_file_governance"
    | "evaluator_strategic_block"
    | "evaluator_failure_limit"
    | "crash_recovery"
    | "rollback_incomplete"
    | "engine_error"
    | "guardrail_block";
  title: string;
  summary: string;
  next_action: string;
  severity: "info" | "warning" | "critical";
}

interface ArtifactCompletenessStatus {
  kind: "none" | "log_only" | "partial_bundle" | "full_bundle";
  label: string;
  latest_round_timestamp: string | null;
  latest_artifact_at: string | null;
  present: Array<"log" | "summary" | "metrics" | "state_change" | "evaluation">;
  missing: Array<"log" | "summary" | "metrics" | "state_change" | "evaluation">;
}

interface CrashRecoveryStatus {
  interruption_type: "startup_interrupted" | "round_interrupted";
  interrupted_state: LoopStateName;
  recovered_by: "startup" | "status_check";
  status_check_finalized: boolean;
  normal_round_execution_started: boolean;
  incomplete_work: boolean;
  reason: string;
  summary: string;
  next_action: string;
}

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface RuntimeLoopConfig {
  intervalSeconds: number;
  maxCycles: number;
  exitOnError: boolean;
  budget: {
    usdPerRound: number;
    timeMinutes: number;
    actions: number;
  };
  codex: {
    bin: string;
    model: string;
    profile: string;
    plannerSandbox: SandboxMode;
    executorSandbox: SandboxMode;
    evaluatorSandbox: SandboxMode;
    timeoutMs: number;
  };
}

interface SaveConfigResponse {
  ok: boolean;
  config: RuntimeLoopConfig;
}

interface AuthStatusResponse {
  tokenRequired: boolean;
}

interface AuthLoginResponse {
  ok: boolean;
  tokenRequired: boolean;
}

interface GoalResponse {
  goal: string;
}

interface ProjectRoleResponse {
  count: number;
  roles: ProjectRoleItem[];
}

type ProjectRoleName = "planner" | "product_manager" | "executor" | "evaluator";

interface ProjectRoleItem {
  role: ProjectRoleName;
  title: string;
  path: string;
  exists: boolean;
  definition: string;
}

interface FrictionIndex {
  reworkChurnRate: number;
  averageActions: number;
  leaderInterventionCount: number;
  overEngineeringCount: number;
  hotFilePressureCount: number;
  healthStatus: "healthy" | "at_risk";
}

const stateTone: Record<LoopStateName, string> = {
  idle: "bg-slate text-mist",
  starting: "bg-sky-300/20 text-sky-100",
  running: "bg-accent/20 text-accent",
  cooldown: "bg-sky-300/20 text-sky-200",
  paused: "bg-warning/20 text-warning",
  stopping: "bg-ember/20 text-ember",
  error: "bg-red-500/20 text-red-300"
};

const stateLabel: Record<LoopStateName, string> = {
  idle: "idle",
  starting: "starting",
  running: "running",
  cooldown: "resting",
  paused: "paused",
  stopping: "stopping",
  error: "error"
};

interface ControlAvailability {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
}

type LifecycleControlPath = "/api/loop/start" | "/api/loop/pause" | "/api/loop/resume" | "/api/loop/stop";

const operatorReasonTone: Record<OperatorStatusReason["severity"], string> = {
  info: "border-white/10 bg-ink/60 text-mist/80",
  warning: "border-warning/40 bg-warning/10 text-warning",
  critical: "border-red-400/40 bg-red-500/10 text-red-100"
};

const artifactCompletenessTone: Record<ArtifactCompletenessStatus["kind"], string> = {
  none: "border-white/10 bg-ink/60 text-mist/80",
  log_only: "border-warning/40 bg-warning/10 text-warning",
  partial_bundle: "border-warning/40 bg-warning/10 text-warning",
  full_bundle: "border-accent/30 bg-accent/10 text-accent"
};

const budgetHealthTone: Record<BudgetHealth, string> = {
  healthy: "border-accent/30 bg-accent/10 text-accent",
  warning: "border-warning/40 bg-warning/10 text-warning",
  breached: "border-ember/40 bg-ember/10 text-ember"
};

const budgetBarTone: Record<BudgetHealth, string> = {
  healthy: "bg-accent",
  warning: "bg-warning",
  breached: "bg-ember"
};

const TOKEN_STORAGE_KEY = "ailoop-console-admin-token";

function readStoredToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

function saveStoredToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearStoredToken(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function deriveCliProvider(bin: string): CliProvider {
  const basename = bin
    .trim()
    .split(/[/\\]/)
    .pop()
    ?.toLowerCase() ?? "";
  if (basename === "claude" || basename.startsWith("claude")) {
    return "claude";
  }
  return "codex";
}

export function summarizeApiError(status: number, body: string, contentType?: string | null): string {
  const trimmedBody = body.trim();
  const normalizedContentType = (contentType ?? "").toLowerCase();

  if (normalizedContentType.includes("application/json") && trimmedBody.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedBody) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Fall through to plain-text summarization.
    }
  }

  const looksLikeHtml =
    normalizedContentType.includes("text/html") ||
    trimmedBody.startsWith("<!doctype html") ||
    trimmedBody.startsWith("<html") ||
    trimmedBody.includes("<body");

  if (looksLikeHtml) {
    return `Server error (${status}). The console returned an HTML error page instead of JSON.`;
  }

  const collapsed = trimmedBody.replace(/\s+/g, " ").replace(/<[^>]+>/g, "").trim();
  if (!collapsed) {
    return `Request failed: ${status}`;
  }

  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

async function api<T>(url: string, init?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (token && token.trim()) {
    headers.set("authorization", `Bearer ${token.trim()}`);
  }

  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Unauthorized");
    }
    const text = await response.text();
    throw new Error(summarizeApiError(response.status, text, response.headers.get("content-type")));
  }
  return (await response.json()) as T;
}

function isUnauthorizedError(message: string): boolean {
  return message.includes("Unauthorized");
}

function isLifecycleControlRejection(message: string): boolean {
  return message.startsWith("Invalid control transition:");
}

export function deriveControlAvailability(state?: LoopStateName | null): ControlAvailability {
  if (!state) {
    return {
      canStart: false,
      canPause: false,
      canResume: false,
      canStop: false
    };
  }

  return {
    canStart: state === "idle" || state === "error",
    canPause: state === "starting" || state === "running" || state === "cooldown",
    canResume: state === "paused",
    canStop: state === "starting" || state === "running" || state === "cooldown" || state === "paused"
  };
}

export async function postControlAndRefresh(
  request: () => Promise<void>,
  refresh: () => Promise<void>
): Promise<void> {
  try {
    await request();
    await refresh();
  } catch (error) {
    try {
      await refresh();
    } catch {
      // Keep the original control error visible to the operator.
    }
    throw error;
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "0s";
  }
  return `${Math.round(ms / 1000)}s`;
}

function formatBudgetValue(dimension: BudgetDimension, used: number, limit: number): string {
  if (dimension === "cost") {
    return `${used.toFixed(4)} / ${limit}`;
  }
  if (dimension === "time") {
    return `${formatMs(used)} / ${Math.round(limit / 60_000)}m`;
  }
  return `${used} / ${limit}`;
}

function formatBudgetHealthLabel(health: BudgetHealth): string {
  return health;
}

function formatBudgetDimensionName(dimension: BudgetDimension): string {
  if (dimension === "cost") {
    return "USD";
  }
  if (dimension === "time") {
    return "Time";
  }
  return "Actions";
}

type StepStatus = "done" | "current" | "pending";

interface RoleRuntimeStep {
  key: "planner" | "executor" | "evaluator" | "cooldown";
  title: string;
  description: string;
  status: StepStatus;
}

const compactRunTimestampPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

function parseRunTimestamp(timestamp: string): Date | null {
  const normalizedTimestamp = compactRunTimestampPattern.test(timestamp)
    ? timestamp.replace(compactRunTimestampPattern, "$1T$2:$3:$4.$5Z")
    : timestamp;
  const parsed = new Date(normalizedTimestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRunTimestamp(timestamp: string): string {
  const parsed = parseRunTimestamp(timestamp);
  if (!parsed) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(parsed);
}

function resolveRoleRuntimeCurrentIndex(phase: ReturnType<typeof deriveRoundProgress>["phase"]): number {
  if (phase === "planner") {
    return 0;
  }
  if (phase === "executor") {
    return 1;
  }
  if (phase === "evaluator") {
    return 2;
  }
  if (phase === "cooldown") {
    return 3;
  }
  return -1;
}

interface RunArtifactBundle {
  timestamp: string;
  summary: string | null;
  metrics: Record<string, unknown> | null;
  log: string | null;
  state_change: string | null;
  hot_file_governance: HotFileGovernanceResult | null;
  artifacts: RunArtifactPresence;
  active_requirement: RequirementArtifactView;
  evaluation: {
    decision: "pass" | "fail";
    justification: string;
    evidence: string[];
    aggregate_score?: number;
    dimensions?: Array<{
      dimension: string;
      decision: "pass" | "fail" | "unknown";
      score?: number;
      confidence?: number;
      justification: string;
      evidence: string[];
      blocking_issues: string[];
      recommended_next_action?: string;
    }>;
    recommended_next_action?: string;
  } | null;
}

interface EvidenceBlockProps {
  title: string;
  items: string[];
  emptyMessage: string;
}

function EvidenceBlock({ title, items, emptyMessage }: EvidenceBlockProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-ink/70 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mist/60">{title}</p>
      {items.length > 0 ? (
        <div className="mt-3 space-y-2">
          {items.map((item, index) => (
            <div key={`${title}-${index}-${item}`} className="rounded-xl border border-white/10 bg-panel/60 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent/80">{index + 1}</p>
              <p className="mt-1 text-sm leading-6 text-mist/85">{item}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-mist/60">{emptyMessage}</p>
      )}
    </div>
  );
}

export function RunArtifactEvidenceGrid({ report }: { report: RoundReport }) {
  return (
    <div className="mt-4 grid gap-3 xl:grid-cols-4">
      <EvidenceBlock
        title="Executor Action Trace"
        items={report.executorActionTrace}
        emptyMessage="No executor action trace captured."
      />
      <EvidenceBlock
        title="Material State Change"
        items={report.materialStateChange}
        emptyMessage="No material state change summary captured."
      />
      <EvidenceBlock
        title="Verification Evidence"
        items={report.verificationEvidence}
        emptyMessage="No verification evidence captured."
      />
      <EvidenceBlock
        title="Operational Follow-up"
        items={report.operationalEvidence}
        emptyMessage="No operational evidence captured."
      />
    </div>
  );
}

export function CrashRecoveryPanel({ crashRecovery }: { crashRecovery: CrashRecoveryStatus | null }) {
  if (!crashRecovery) {
    return null;
  }

  const interruptionLabel =
    crashRecovery.interruption_type === "startup_interrupted" ? "Startup interrupted" : "Round interrupted";
  const recoverySourceLabel = crashRecovery.recovered_by === "startup" ? "Recovered during engine startup" : "Recovered during status check";
  const recoveryMutationLabel = crashRecovery.status_check_finalized ? "Finalized during status check" : "Already finalized before this refresh";
  const executionLabel = crashRecovery.normal_round_execution_started
    ? "Normal round execution had started"
    : "Normal round execution never started";
  const workLabel = crashRecovery.incomplete_work ? "Round may be incomplete" : "No incomplete round work detected";

  return (
    <div className="mt-4 rounded-2xl border border-warning/40 bg-warning/10 p-4 shadow-[0_0_0_1px_rgba(255,196,92,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-warning">Crash Recovery</p>
          <h2 className="mt-2 text-xl font-semibold text-mist">{interruptionLabel}</h2>
          <p className="mt-2 text-sm leading-6 text-mist/80">{crashRecovery.summary}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.16em]">
          <span className="rounded-full border border-warning/40 bg-warning/15 px-3 py-1 text-warning">{recoveryMutationLabel}</span>
          <span className="rounded-full border border-white/10 bg-ink/70 px-3 py-1 text-mist/80">{workLabel}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Recovery Source</p>
          <p className="mt-2 text-sm font-semibold text-mist">{recoverySourceLabel}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Affected State</p>
          <p className="mt-2 text-sm font-semibold text-mist">{crashRecovery.interrupted_state}</p>
          <p className="mt-1 text-xs text-mist/60">{executionLabel}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Recovery Reason</p>
          <p className="mt-2 text-sm font-semibold text-mist">{crashRecovery.reason}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Next Safe Action</p>
          <p className="mt-2 text-sm font-semibold text-mist">{crashRecovery.next_action}</p>
        </div>
      </div>
    </div>
  );
}

export function OperatorReasonPanel({ operatorReason }: { operatorReason: OperatorStatusReason | null }) {
  if (!operatorReason) {
    return (
      <div className="rounded-2xl border border-white/10 bg-ink/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-mist/60">Pause / Risk Reason</p>
            <h2 className="mt-2 text-xl font-semibold text-mist">No active pause or risk signal</h2>
            <p className="mt-2 text-sm leading-6 text-mist/70">The current status surface does not show a live pause or safety block.</p>
          </div>
          <span className="rounded-full border border-white/10 bg-panel/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-mist/70">
            normal
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] ${operatorReasonTone[operatorReason.severity]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-mist/70">Pause / Risk Reason</p>
          <h2 className="mt-2 text-xl font-semibold text-mist">{operatorReason.title}</h2>
          <p className="mt-2 text-sm leading-6 text-mist/85">{operatorReason.summary}</p>
        </div>
        <span className="rounded-full border border-current/20 bg-ink/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-current">
          {operatorReason.severity}
        </span>
      </div>
      <div className="mt-4 rounded-xl border border-white/10 bg-ink/70 p-3">
        <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Next Safe Action</p>
        <p className="mt-2 text-sm font-semibold text-mist">{operatorReason.next_action}</p>
      </div>
    </div>
  );
}

export function ControlErrorPanel({
  message,
  state
}: {
  message: string | null;
  state?: LoopStateName | null;
}) {
  if (!message) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl border border-ember/40 bg-ember/10 p-4 shadow-[0_0_0_1px_rgba(255,122,82,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-ember">Control rejected</p>
          <h2 className="mt-2 text-xl font-semibold text-mist">Lifecycle state unchanged</h2>
          <p className="mt-2 text-sm leading-6 text-mist/85">{message}</p>
        </div>
        <span className="rounded-full border border-ember/30 bg-ink/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-ember">
          Persisted state: {state ?? "unknown"}
        </span>
      </div>
      <p className="mt-4 text-sm text-mist/70">The request did not mutate the backend lifecycle state.</p>
    </div>
  );
}

function formatArtifactKindLabel(kind: ArtifactCompletenessStatus["present"][number]): string {
  if (kind === "state_change") {
    return "state change";
  }
  return kind;
}

function fallbackRunArtifactPresence(): RunArtifactPresence {
  return {
    kind: "full_bundle",
    label: "Full evidence bundle",
    present: ["log", "summary", "metrics", "state_change", "evaluation"],
    missing: []
  };
}

function resolveRunArtifactPresence(run: Pick<RunHistoryItem, "artifacts">): RunArtifactPresence {
  return run.artifacts ?? fallbackRunArtifactPresence();
}

function formatArtifactPresenceList(items: RunArtifactPresence["present"]): string {
  return items.length > 0 ? items.map(formatArtifactKindLabel).join(", ") : "none";
}

function formatHotFileGovernanceLabels(signal: HotFileGovernanceResult): string {
  return signal.heuristic_labels.length > 0 ? signal.heuristic_labels.join(", ") : "none";
}

export function HotFileGovernanceBadge({ signal }: { signal: HotFileGovernanceResult }) {
  return (
    <span className="rounded-full border border-warning/30 bg-warning/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-warning">
      {signal.result_class.replace(/_/g, " ")}
    </span>
  );
}

export function HotFileGovernancePanel({
  signal,
  compact = false
}: {
  signal: HotFileGovernanceResult | null;
  compact?: boolean;
}) {
  if (!signal) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-warning">Hot-File Governance</p>
          <h2 className="mt-2 text-xl font-semibold text-mist">{signal.file_path}</h2>
          <p className="mt-2 text-sm leading-6 text-mist/85">{signal.reason}</p>
        </div>
        <HotFileGovernanceBadge signal={signal} />
      </div>
      <div className={`mt-4 grid gap-3 ${compact ? "md:grid-cols-2" : "md:grid-cols-3"}`}>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Governance Class</p>
          <p className="mt-2 text-sm font-semibold text-mist">{signal.result_class}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Heuristic Labels</p>
          <p className="mt-2 text-sm font-semibold text-mist">{formatHotFileGovernanceLabels(signal)}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Recommended Next Action</p>
          <p className="mt-2 text-sm font-semibold text-mist">{signal.recommended_next_action}</p>
        </div>
      </div>
    </div>
  );
}

export function ArtifactCompletenessPanel({
  artifactCompleteness
}: {
  artifactCompleteness: ArtifactCompletenessStatus | null;
}) {
  if (!artifactCompleteness) {
    return null;
  }

  const latestArtifactLabel = artifactCompleteness.latest_artifact_at
    ? formatRunTimestamp(artifactCompleteness.latest_artifact_at)
    : "No persisted round artifacts yet";
  const detailLabel =
    artifactCompleteness.kind === "none"
      ? "No persisted round evidence has been written yet."
      : artifactCompleteness.missing.length === 0
      ? "All required evidence artifacts are present for the latest round."
      : `Missing: ${artifactCompleteness.missing.map(formatArtifactKindLabel).join(", ")}`;

  return (
    <div className={`rounded-2xl border p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] ${artifactCompletenessTone[artifactCompleteness.kind]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-mist/70">Artifact Completeness</p>
          <h2 className="mt-2 text-xl font-semibold text-mist">{artifactCompleteness.label}</h2>
          <p className="mt-2 text-sm leading-6 text-mist/85">{detailLabel}</p>
        </div>
        <span className="rounded-full border border-current/20 bg-ink/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-current">
          {artifactCompleteness.kind.replace("_", " ")}
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Latest Artifact Timestamp</p>
          <p className="mt-2 text-sm font-semibold text-mist">{latestArtifactLabel}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/60">Latest Round</p>
          <p className="mt-2 text-sm font-semibold text-mist">{artifactCompleteness.latest_round_timestamp ?? "No round artifacts yet"}</p>
        </div>
      </div>
    </div>
  );
}

export function BudgetHealthPanel({
  budgetHealth,
  currentBudget
}: {
  budgetHealth: BudgetHealthStatus | null;
  currentBudget: LoopStatus["current_budget"];
}) {
  if (!budgetHealth || !currentBudget) {
    return <p className="text-sm text-mist/70">No budget usage yet.</p>;
  }

  const breachedDimensionLabel = budgetHealth.breached_dimension
    ? formatBudgetDimensionName(budgetHealth.breached_dimension)
    : null;

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] ${budgetHealthTone[budgetHealth.overall]}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-mist/70">Budget Health</p>
            <h2 className="mt-2 text-xl font-semibold text-mist">{formatBudgetHealthLabel(budgetHealth.overall)}</h2>
            <p className="mt-2 text-sm leading-6 text-mist/85">
              {breachedDimensionLabel
                ? `Budget pause is pinned to ${breachedDimensionLabel}. The last persisted budget snapshot is preserved for review.`
                : "Current budget health is derived from the last persisted usage snapshot."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.16em]">
            <span className="rounded-full border border-current/20 bg-ink/70 px-3 py-1 text-current">
              {formatBudgetHealthLabel(budgetHealth.overall)}
            </span>
            {breachedDimensionLabel ? (
              <span className="rounded-full border border-current/20 bg-ink/70 px-3 py-1 text-current">
                Breached Dimension: {breachedDimensionLabel}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {budgetHealth.dimensions.map((dimension) => {
          const ratio = Math.max(0, Math.min(100, dimension.ratio * 100));
          return (
            <div key={dimension.dimension} className="rounded-2xl border border-white/10 bg-ink/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mist/65">{dimension.label}</p>
                <span
                  className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${budgetHealthTone[dimension.health]}`}
                >
                  {formatBudgetHealthLabel(dimension.health)}
                </span>
              </div>
              <p className="mt-3 text-xl font-semibold text-mist">
                {formatBudgetValue(dimension.dimension, dimension.used, dimension.limit)}
              </p>
              <div className="mt-3 h-2 rounded-full bg-panel/80">
                <div
                  className={`h-2 rounded-full ${budgetBarTone[dimension.health]}`}
                  style={{ width: `${ratio}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-mist/60">
                {formatBudgetDimensionName(dimension.dimension)} health: {formatBudgetHealthLabel(dimension.health)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SystemHealthPanel({ frictionIndex }: { frictionIndex: FrictionIndex | null }) {
  if (!frictionIndex) {
    return null;
  }

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-ink/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-mist/70">System Health (Friction Index)</p>
          <p className="mt-1 text-xs text-mist/55">Recent telemetry from the last 20 rounds.</p>
        </div>
        <span
          className={`h-2 w-2 rounded-full ${
            frictionIndex.healthStatus === "healthy"
              ? "bg-accent shadow-[0_0_8px_rgba(102,255,187,0.6)]"
              : "bg-ember animate-pulse shadow-[0_0_8px_rgba(255,102,102,0.6)]"
          }`}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-5">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-mist/50">Rework Churn</p>
          <p className={`text-lg font-bold ${frictionIndex.reworkChurnRate > 0.4 ? "text-ember" : "text-mist"}`}>
            {(frictionIndex.reworkChurnRate * 100).toFixed(0)}%
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-mist/50">Avg Actions</p>
          <p className={`text-lg font-bold ${frictionIndex.averageActions > 50 ? "text-warning" : "text-mist"}`}>
            {frictionIndex.averageActions.toFixed(1)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-mist/50">Interventions</p>
          <p className="text-lg font-bold text-mist">{frictionIndex.leaderInterventionCount}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-mist/50">Over-Engineering</p>
          <p className="text-lg font-bold text-mist">{frictionIndex.overEngineeringCount}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-mist/50">Hot-File Pressure</p>
          <p className={`text-lg font-bold ${frictionIndex.hotFilePressureCount > 0 ? "text-warning" : "text-mist"}`}>
            {frictionIndex.hotFilePressureCount}
          </p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-mist/45">governance blocks</p>
        </div>
      </div>
    </div>
  );
}

export function LifecycleStatusGrid({ status }: { status: LoopStatus | null }) {
  const pendingInstructionCount = status?.pending_instruction_count ?? 0;
  const pauseReason = status?.pause_reason ?? "None active";

  return (
    <div className="mt-5 grid gap-3 text-sm text-mist/80 md:grid-cols-3 xl:grid-cols-6">
      <div className="rounded-xl border border-white/10 bg-ink/60 p-3">Round: {status?.round ?? "-"}</div>
      <div className="rounded-xl border border-white/10 bg-ink/60 p-3">PID: {status?.pid ?? "-"}</div>
      <div className="rounded-xl border border-white/10 bg-ink/60 p-3">Process: {status?.pid_alive ? "alive" : "not running"}</div>
      <div className="rounded-xl border border-white/10 bg-ink/60 p-3">
        Pending instructions: {pendingInstructionCount} queued
      </div>
      <div className="rounded-xl border border-white/10 bg-ink/60 p-3">Pause reason: {pauseReason}</div>
      <div className="rounded-xl border border-white/10 bg-ink/60 p-3">
        Evaluator failures: {status?.consecutive_evaluator_failures ?? 0}
      </div>
    </div>
  );
}

function ArtifactPresenceCard({ artifacts }: { artifacts: RunArtifactPresence }) {
  const tone =
    artifacts.kind === "full_bundle"
      ? "border-accent/30 bg-accent/10"
      : artifacts.kind === "none"
        ? "border-white/10 bg-ink/60"
        : "border-warning/40 bg-warning/10";

  return (
    <div className={`rounded-2xl border p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-mist/70">Evidence Availability</p>
          <h2 className="mt-2 text-xl font-semibold text-mist">{artifacts.label}</h2>
          <p className="mt-2 text-sm leading-6 text-mist/85">
            Present: {formatArtifactPresenceList(artifacts.present)}
          </p>
          <p className="mt-1 text-sm leading-6 text-mist/70">
            Missing: {artifacts.missing.length > 0 ? formatArtifactPresenceList(artifacts.missing) : "none"}
          </p>
        </div>
        <span className="rounded-full border border-current/20 bg-ink/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-current">
          {artifacts.kind.replace("_", " ")}
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [tokenRequired, setTokenRequired] = useState<boolean | null>(null);
  const [authToken, setAuthToken] = useState<string>(() => readStoredToken());
  const [loginToken, setLoginToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [status, setStatus] = useState<LoopStatus | null>(null);
  const [frictionIndex, setFrictionIndex] = useState<FrictionIndex | null>(null);
  const [goal, setGoal] = useState("");
  const [roles, setRoles] = useState<ProjectRoleItem[]>([]);
  const [runs, setRuns] = useState<RunHistoryItem[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [isGoalDialogOpen, setIsGoalDialogOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ProjectRoleItem | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunHistoryItem | null>(null);
  const [selectedArtifacts, setSelectedArtifacts] = useState<RunArtifactBundle | null>(null);
  const [selectedRequirement, setSelectedRequirement] = useState<RequirementArtifactView | null>(null);
  const [selectedGovernance, setSelectedGovernance] = useState<GovernanceDetails | null>(null);
  const [artifactsBusy, setArtifactsBusy] = useState(false);
  const [runHistoryPage, setRunHistoryPage] = useState(1);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeLoopConfig | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAuthenticated = tokenRequired === false || (tokenRequired === true && authToken.trim().length > 0);
  const displayLogText = useMemo(() => buildLogViewerText(logs), [logs]);
  const logTailFollowBehavior = useMemo(() => resolveLogTailFollowBehavior(status?.state), [status?.state]);
  const roundProgress = useMemo(
    () =>
      deriveRoundProgress({
        state: status?.state,
        round: status?.round,
        logs
      }),
    [status?.state, status?.round, logs]
  );
  const roleRuntimeSteps = useMemo<RoleRuntimeStep[]>(() => {
    const currentIndex = resolveRoleRuntimeCurrentIndex(roundProgress.phase);
    const baseSteps: Array<Omit<RoleRuntimeStep, "status">> = [
      { key: "planner", title: "Project Planner", description: "生成本轮子任务" },
      { key: "executor", title: "Executor", description: "执行任务并落地变更" },
      { key: "evaluator", title: "Evaluator", description: "核验结果并给出结论" },
      { key: "cooldown", title: "Cooldown", description: "收尾并等待下一轮" }
    ];

    return baseSteps.map((step, index) => {
      let status: StepStatus = "pending";
      if (currentIndex >= 0 && index < currentIndex) {
        status = "done";
      } else if (currentIndex === index) {
        status = "current";
      }

      return {
        ...step,
        status,
        description: currentIndex === index ? roundProgress.step : step.description
      };
    });
  }, [roundProgress.phase, roundProgress.step]);

  const handleRequestError = (requestError: unknown, unauthorizedMessage: string): void => {
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    if (isUnauthorizedError(message)) {
      clearStoredToken();
      setAuthToken("");
      setAuthError(unauthorizedMessage);
      setRoles([]);
      setSelectedRole(null);
      setError(null);
      return;
    }
    setError(message);
  };

  const refresh = async (tokenOverride?: string): Promise<void> => {
    const activeToken = tokenOverride ?? authToken;
    try {
      const [nextStatus, nextGoal, nextRuns, nextLogs, nextRoles, nextFriction] = await Promise.all([
        api<LoopStatus>("/api/status", undefined, activeToken),
        api<GoalResponse>("/api/goal", undefined, activeToken),
        api<RunHistoryItem[]>("/api/runs?limit=20", undefined, activeToken),
        api<{ lines: string[] }>("/api/logs/tail?lines=120", undefined, activeToken),
        api<ProjectRoleResponse>("/api/roles", undefined, activeToken),
        api<FrictionIndex>("/api/metrics/friction-index", undefined, activeToken).catch(() => null)
      ]);
      setStatus(nextStatus);
      setGoal(nextGoal.goal ?? "");
      setRuns(nextRuns);
      setLogs(nextLogs.lines);
      setRoles(nextRoles.roles ?? []);
      setFrictionIndex(nextFriction);
      setError(null);
      setAuthError(null);
    } catch (requestError) {
      handleRequestError(requestError, "Token 校验失败，请重新登录。");
    }
  };

  const refreshRuntimeConfig = async (tokenOverride?: string): Promise<void> => {
    const activeToken = tokenOverride ?? authToken;
    try {
      const next = await api<RuntimeLoopConfig>("/api/config", undefined, activeToken);
      setRuntimeConfig(next);
      setError(null);
      setAuthError(null);
    } catch (requestError) {
      handleRequestError(requestError, "登录状态已失效，请重新登录。");
    }
  };

  const bootstrapAuth = async (): Promise<void> => {
    try {
      const authStatus = await api<AuthStatusResponse>("/api/auth/status");
      setTokenRequired(authStatus.tokenRequired);
      setError(null);

      if (authStatus.tokenRequired && !authToken.trim()) {
        setStatus(null);
        setGoal("");
        setRoles([]);
        setRuns([]);
        setLogs([]);
        setRuntimeConfig(null);
        return;
      }

      await Promise.all([refresh(), refreshRuntimeConfig()]);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  useEffect(() => {
    void bootstrapAuth();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [isAuthenticated, authToken]);

  const controlAvailability = useMemo(() => deriveControlAvailability(status?.state), [status?.state]);

  const browserTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Local", []);
  const runHistoryPagination = useMemo(
    () => paginateRunHistory(runs, runHistoryPage, RUN_HISTORY_PAGE_SIZE),
    [runs, runHistoryPage]
  );
  const selectedArtifactsReport = useMemo(() => {
    if (!selectedArtifacts) {
      return null;
    }

    return projectRunHistoryReport({
      timestamp: selectedArtifacts.timestamp,
      summary: selectedArtifacts.summary ?? "",
      metrics: selectedArtifacts.metrics,
      evaluation: selectedArtifacts.evaluation
    });
  }, [selectedArtifacts]);

  useEffect(() => {
    if (runHistoryPagination.currentPage !== runHistoryPage) {
      setRunHistoryPage(runHistoryPagination.currentPage);
    }
  }, [runHistoryPage, runHistoryPagination.currentPage]);

  const sendLifecycleControl = async (path: LifecycleControlPath): Promise<void> => {
    try {
      setBusy(path);
      setControlError(null);
      await postControlAndRefresh(
        () =>
          api(path, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            }
          }, authToken),
        () => refresh()
      );
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      if (isUnauthorizedError(message)) {
        handleRequestError(requestError, "控制操作失败：请先重新登录。");
      } else if (isLifecycleControlRejection(message)) {
        setControlError(message);
      } else {
        handleRequestError(requestError, "控制操作失败：请稍后重试。");
      }
    } finally {
      setBusy(null);
    }
  };

  const submitLogin = async (): Promise<void> => {
    const trimmed = loginToken.trim();
    if (!trimmed) {
      setAuthError("请输入 token。");
      return;
    }

    try {
      setAuthBusy(true);
      await api<AuthLoginResponse>(
        "/api/auth/login",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ token: trimmed })
        },
        undefined
      );
      saveStoredToken(trimmed);
      setAuthToken(trimmed);
      setLoginToken("");
      setAuthError(null);
      setError(null);
      await Promise.all([refresh(trimmed), refreshRuntimeConfig(trimmed)]);
    } catch {
      setAuthError("Token 无效，请重试。");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = (): void => {
    clearStoredToken();
    setAuthToken("");
    setStatus(null);
    setGoal("");
    setRoles([]);
    setRuns([]);
    setLogs([]);
    setSelectedRole(null);
    setSelectedRequirement(null);
    setRuntimeConfig(null);
    setAuthError(null);
    setError(null);
  };

  const submitInstruction = async (): Promise<void> => {
    const trimmed = instruction.trim();
    if (!trimmed) {
      return;
    }
    try {
      setBusy("/api/loop/instruct");
      await api("/api/loop/instruct", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ message: trimmed })
      }, authToken);
      await refresh();
      setInstruction("");
      setError(null);
    } catch (requestError) {
      handleRequestError(requestError, "控制操作失败：请先重新登录。");
    } finally {
      setBusy(null);
    }
  };

  const updateTopLevelNumber = (key: "intervalSeconds" | "maxCycles", raw: string): void => {
    if (!runtimeConfig) {
      return;
    }
    const next = Number(raw);
    setRuntimeConfig({
      ...runtimeConfig,
      [key]: Number.isFinite(next) ? next : runtimeConfig[key]
    });
  };

  const updateBudgetNumber = (key: "usdPerRound" | "timeMinutes" | "actions", raw: string): void => {
    if (!runtimeConfig) {
      return;
    }
    const next = Number(raw);
    setRuntimeConfig({
      ...runtimeConfig,
      budget: {
        ...runtimeConfig.budget,
        [key]: Number.isFinite(next) ? next : runtimeConfig.budget[key]
      }
    });
  };

  const updateCodexNumber = (key: "timeoutMs", raw: string): void => {
    if (!runtimeConfig) {
      return;
    }
    const next = Number(raw);
    setRuntimeConfig({
      ...runtimeConfig,
      codex: {
        ...runtimeConfig.codex,
        [key]: Number.isFinite(next) ? next : runtimeConfig.codex[key]
      }
    });
  };

  const saveRuntimeConfig = async (): Promise<void> => {
    if (!runtimeConfig) {
      return;
    }

    try {
      setConfigBusy(true);
      const response = await api<SaveConfigResponse>("/api/config", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(runtimeConfig)
      }, authToken);
      setRuntimeConfig(response.config);
      setError(null);
    } catch (requestError) {
      handleRequestError(requestError, "配置保存失败：请先重新登录。");
    } finally {
      setConfigBusy(false);
    }
  };

  const resetRuntimeConfig = async (): Promise<void> => {
    try {
      setConfigBusy(true);
      const response = await api<SaveConfigResponse>("/api/config/reset", {
        method: "POST"
      }, authToken);
      setRuntimeConfig(response.config);
      setError(null);
    } catch (requestError) {
      handleRequestError(requestError, "配置重置失败：请先重新登录。");
    } finally {
      setConfigBusy(false);
    }
  };

  const fetchArtifacts = async (run: RunHistoryItem): Promise<void> => {
    try {
      setArtifactsBusy(true);
      setSelectedGovernance(null);
      const bundle = await api<RunArtifactBundle & { governance: GovernanceDetails }>(`/api/runs/${run.timestamp}/artifacts`, undefined, authToken);
      const hotFileGovernance =
        bundle.governance?.hot_file_governance ??
        bundle.hot_file_governance ??
        run.hot_file_governance ??
        run.evaluation?.hot_file_governance ??
        null;
      setSelectedArtifacts({
        ...bundle,
        timestamp: run.timestamp,
        summary: bundle.summary ?? run.summary,
        metrics: bundle.metrics ?? run.metrics,
        evaluation: bundle.evaluation ?? run.evaluation,
        hot_file_governance: hotFileGovernance,
        artifacts: bundle.artifacts ?? resolveRunArtifactPresence(run)
      });
      setSelectedGovernance({
        ...bundle.governance,
        hot_file_governance: hotFileGovernance
      });
      setError(null);
    } catch (requestError) {
      handleRequestError(requestError, "无法获取运行详情：请重试或重新登录。");
    } finally {
      setArtifactsBusy(false);
    }
  };
  useEffect(() => {
    if (!selectedRun && !selectedArtifacts && !selectedRole && !selectedRequirement && !isGoalDialogOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSelectedRun(null);
        setSelectedArtifacts(null);
        setSelectedRole(null);
        setSelectedRequirement(null);
        setIsGoalDialogOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedRun, selectedArtifacts, selectedRole, selectedRequirement, isGoalDialogOpen]);

  if (tokenRequired === null) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-4 py-8">
        <section className="w-full rounded-3xl border border-white/10 bg-panel/80 p-6 text-mist shadow-lift backdrop-blur">
          <h1 className="text-2xl font-bold">Autonomy Dashboard</h1>
          <p className="mt-3 text-sm text-mist/70">Checking authentication status...</p>
        </section>
      </main>
    );
  }

  if (tokenRequired && !authToken.trim()) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-4 py-8">
        <section className="w-full rounded-3xl border border-white/10 bg-panel/80 p-6 text-mist shadow-lift backdrop-blur">
          <p className="text-xs uppercase tracking-[0.32em] text-accent/80">Admin Access</p>
          <h1 className="mt-1 text-3xl font-bold">Login Required</h1>
          <p className="mt-3 text-sm text-mist/70">请输入管理后台 Token 进行登录。</p>
          <div className="mt-5 flex flex-col gap-3 md:flex-row">
            <input
              value={loginToken}
              onChange={(event) => setLoginToken(event.target.value)}
              type="password"
              placeholder="Paste admin token"
              className="w-full rounded-xl border border-white/15 bg-ink/80 px-4 py-3 text-mist outline-none ring-accent/40 transition focus:ring"
            />
            <button
              onClick={() => void submitLogin()}
              disabled={authBusy}
              className="rounded-xl bg-accent px-5 py-3 font-semibold text-ink transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-accent/40"
            >
              {authBusy ? "Verifying..." : "Login"}
            </button>
          </div>
          {authError ? <p className="mt-4 rounded-lg bg-red-500/20 p-3 text-sm text-red-200">{authError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <section className="reveal rounded-3xl border border-white/10 bg-panel/80 p-6 shadow-lift backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-accent/80">AILoop Control Plane</p>
            <h1 className="mt-1 text-3xl font-bold text-mist md:text-4xl">Autonomy Dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold uppercase tracking-[0.2em] ${status ? stateTone[status.state] : "bg-slate text-mist"
                }`}
            >
              {status ? stateLabel[status.state] : "loading"}
            </span>
            {status?.crash_recovery ? (
              <span className="rounded-full border border-warning/40 bg-warning/15 px-4 py-2 text-sm font-semibold uppercase tracking-[0.2em] text-warning">
                crash recovery
              </span>
            ) : null}
            {tokenRequired ? (
              <button
                onClick={logout}
                className="rounded-full border border-white/20 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-mist/80 transition hover:border-ember hover:text-ember"
              >
                Logout
              </button>
            ) : null}
          </div>
        </div>

        <LifecycleStatusGrid status={status} />

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <OperatorReasonPanel operatorReason={status?.operator_reason ?? null} />
          <ArtifactCompletenessPanel artifactCompleteness={status?.artifact_completeness ?? null} />
        </div>
        <div className="mt-4">
          <HotFileGovernancePanel signal={status?.hot_file_governance ?? null} />
        </div>
        <CrashRecoveryPanel crashRecovery={status?.crash_recovery ?? null} />

        <SystemHealthPanel frictionIndex={frictionIndex} />

        <div className="mt-4 rounded-xl border border-white/10 bg-ink/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-mist/70">Ultimate Goal</p>
            <button
              onClick={() => setIsGoalDialogOpen(true)}
              className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent"
            >
              弹窗查看
            </button>
          </div>
          <GoalMarkdown goal={goal} />
        </div>

        <div className="mt-4">
          <RequirementSnapshotCard
            artifact={status?.active_requirement ?? null}
            onOpen={() => {
              if (status?.active_requirement?.exists) {
                setSelectedRequirement(status.active_requirement);
              }
            }}
          />
        </div>

        <div className="mt-6 grid gap-2 md:grid-cols-4">
          <button
            className="rounded-xl flex items-center justify-center gap-2 bg-accent px-4 py-2 font-semibold text-ink transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-accent/40"
            onClick={() => void sendLifecycleControl("/api/loop/start")}
            disabled={busy !== null || configBusy || !controlAvailability.canStart}
          >
            {busy === "/api/loop/start" && (
              <svg className="animate-spin -ml-1 h-4 w-4 text-ink" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            )}
            Start
          </button>
          <button
            className="rounded-xl bg-warning px-4 py-2 font-semibold text-ink transition hover:bg-warning/80 disabled:cursor-not-allowed disabled:bg-warning/40"
            onClick={() => void sendLifecycleControl("/api/loop/pause")}
            disabled={busy !== null || configBusy || !controlAvailability.canPause}
          >
            Pause
          </button>
          <button
            className="rounded-xl bg-sky-300 px-4 py-2 font-semibold text-ink transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:bg-sky-200/50"
            onClick={() => void sendLifecycleControl("/api/loop/resume")}
            disabled={busy !== null || configBusy || !controlAvailability.canResume}
          >
            Resume
          </button>
          <button
            className="rounded-xl bg-ember px-4 py-2 font-semibold text-ink transition hover:bg-ember/80 disabled:cursor-not-allowed disabled:bg-ember/40"
            onClick={() => void sendLifecycleControl("/api/loop/stop")}
            disabled={busy !== null || configBusy || !controlAvailability.canStop}
          >
            Stop
          </button>
        </div>
        <ControlErrorPanel message={controlError} state={status?.state} />
      </section>

      <section className="reveal rounded-3xl border border-white/10 bg-panel/70 p-5 backdrop-blur" style={{ animationDelay: "80ms" }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-mist">Loop Settings</h2>
          <div className="flex gap-2">
            <button
              onClick={() => void resetRuntimeConfig()}
              disabled={configBusy || busy !== null}
              className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-warning hover:text-warning disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset
            </button>
            <button
              onClick={() => void saveRuntimeConfig()}
              disabled={!runtimeConfig || configBusy || busy !== null}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-ink transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-accent/40"
            >
              Save
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-mist/60">Saved settings are used by the next loop start from this console.</p>

        {!runtimeConfig ? (
          <p className="mt-4 text-sm text-mist/70">Loading settings...</p>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm text-mist/80">
              Interval Seconds
              <input
                type="number"
                min={1}
                value={runtimeConfig.intervalSeconds}
                onChange={(event) => updateTopLevelNumber("intervalSeconds", event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              Stop After Rounds (0 = unlimited)
              <input
                type="number"
                min={0}
                value={runtimeConfig.maxCycles}
                onChange={(event) => updateTopLevelNumber("maxCycles", event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              Budget USD / Round
              <input
                type="number"
                min={0}
                step="0.01"
                value={runtimeConfig.budget.usdPerRound}
                onChange={(event) => updateBudgetNumber("usdPerRound", event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              Budget Time (minutes)
              <input
                type="number"
                min={1}
                value={runtimeConfig.budget.timeMinutes}
                onChange={(event) => updateBudgetNumber("timeMinutes", event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              Budget Actions
              <input
                type="number"
                min={1}
                value={runtimeConfig.budget.actions}
                onChange={(event) => updateBudgetNumber("actions", event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              Exit On Error
              <select
                value={runtimeConfig.exitOnError ? "true" : "false"}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    exitOnError: event.target.value === "true"
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </label>
            <label className="text-sm text-mist/80">
              Execution Provider
              <select
                value={deriveCliProvider(runtimeConfig.codex.bin)}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    codex: {
                      ...runtimeConfig.codex,
                      bin: event.target.value === "claude" ? "claude" : "codex"
                    }
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              >
                <option value="codex">Codex CLI</option>
                <option value="claude">Claude CLI</option>
              </select>
              <span className="mt-2 block text-xs text-mist/60">Uses the selected CLI from your PATH by default.</span>
            </label>
            <label className="text-sm text-mist/80">
              CLI Model
              <input
                value={runtimeConfig.codex.model}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    codex: {
                      ...runtimeConfig.codex,
                      model: event.target.value
                    }
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              CLI Profile
              <input
                value={runtimeConfig.codex.profile}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    codex: {
                      ...runtimeConfig.codex,
                      profile: event.target.value
                    }
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80">
              Project Planner Sandbox
              <select
                value={runtimeConfig.codex.plannerSandbox}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    codex: {
                      ...runtimeConfig.codex,
                      plannerSandbox: event.target.value as SandboxMode
                    }
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </label>
            <label className="text-sm text-mist/80">
              Executor Sandbox
              <select
                value={runtimeConfig.codex.executorSandbox}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    codex: {
                      ...runtimeConfig.codex,
                      executorSandbox: event.target.value as SandboxMode
                    }
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </label>
            <label className="text-sm text-mist/80">
              Evaluator Sandbox
              <select
                value={runtimeConfig.codex.evaluatorSandbox}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    codex: {
                      ...runtimeConfig.codex,
                      evaluatorSandbox: event.target.value as SandboxMode
                    }
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </label>
            <label className="text-sm text-mist/80">
              CLI Timeout (ms)
              <input
                type="number"
                min={10000}
                value={runtimeConfig.codex.timeoutMs}
                onChange={(event) => updateCodexNumber("timeoutMs", event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
          </div>
        )}
      </section>

      <section className="reveal grid gap-6" style={{ animationDelay: "120ms" }}>
        <article className="rounded-3xl border border-white/10 bg-panel/70 p-5 backdrop-blur">
          <h2 className="text-lg font-semibold text-mist">Role Runtime</h2>
          <div className="mt-4 rounded-xl border border-white/10 bg-ink/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-[0.2em] text-mist/70">
              <span>{roundProgress.roundLabel}</span>
              <span>{roundProgress.percent}%</span>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              {roleRuntimeSteps.map((step, index) => (
                <div
                  key={step.key}
                  className={`relative rounded-xl border px-3 py-3 ${step.status === "done"
                    ? "border-accent/40 bg-accent/10"
                    : step.status === "current"
                      ? "border-sky-300/50 bg-sky-300/10"
                      : "border-white/10 bg-ink/70"
                    }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${step.status === "done"
                        ? "bg-accent text-ink"
                        : step.status === "current"
                          ? "bg-sky-300 text-ink"
                          : "bg-slate text-mist/80"
                        }`}
                    >
                      {step.status === "done" ? "✓" : index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-mist">{step.title}</p>
                      <p className="mt-1 text-xs text-mist/70">{step.description}</p>
                    </div>
                  </div>
                  {index < roleRuntimeSteps.length - 1 ? (
                    <div className="hidden md:block absolute -right-2 top-1/2 h-[2px] w-4 -translate-y-1/2 bg-white/20" />
                  ) : null}
                </div>
              ))}
            </div>
            <p className="mt-3 rounded-lg border border-white/10 bg-ink/70 px-3 py-2 text-sm text-mist/85">
              Current: {roundProgress.role} - {roundProgress.step}
            </p>
          </div>

          <h2 className="mt-7 text-lg font-semibold text-mist">Project Roles ({roles.length})</h2>
          <p className="mt-2 text-xs text-mist/60">点击角色可查看当前项目角色定义。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {roles.length === 0 ? (
              <p className="text-sm text-mist/70">No role definitions loaded.</p>
            ) : (
              roles.map((role) => (
                <button
                  key={role.role}
                  onClick={() => setSelectedRole(role)}
                  className="rounded-xl border border-white/15 bg-ink/70 px-3 py-3 text-left text-sm text-mist/85 transition hover:border-accent hover:text-accent"
                >
                  <p className="font-semibold">{role.title}</p>
                  <p className="mt-1 text-xs text-mist/65">{role.exists ? "defined" : "default fallback"}</p>
                </button>
              ))
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-white/10 bg-panel/70 p-5 backdrop-blur">
          <BudgetHealthPanel
            budgetHealth={status?.budget_health ?? null}
            currentBudget={status?.current_budget ?? null}
          />

          <h2 className="mt-7 text-lg font-semibold text-mist">Instruction Feed</h2>
          <div className="mt-3 flex flex-col gap-3 md:flex-row">
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Send a next-round instruction..."
              className="w-full rounded-xl border border-white/15 bg-ink/80 px-4 py-3 text-mist outline-none ring-accent/40 transition focus:ring"
            />
            <button
              onClick={() => void submitInstruction()}
              disabled={busy !== null}
              className="rounded-xl bg-accent px-5 py-3 font-semibold text-ink transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-accent/40"
            >
              Send
            </button>
          </div>

          {error ? <p className="mt-4 rounded-lg bg-red-500/20 p-3 text-sm text-red-200">{error}</p> : null}
          {status?.last_error ? (
            <p className="mt-4 rounded-lg bg-warning/20 p-3 text-sm text-warning">Last error: {status.last_error}</p>
          ) : null}
        </article>

        <article className="rounded-3xl border border-white/10 bg-panel/70 p-5 backdrop-blur">
          <h2 className="text-lg font-semibold text-mist">Live Log Tail</h2>
          <div className="mt-4 h-[22rem] overflow-hidden rounded-xl border border-white/10 bg-ink/75">
            {displayLogText ? (
              <ScrollFollow
                startFollowing={logTailFollowBehavior.startFollowing}
                render={({ follow, onScroll }) => (
                  <LazyLog
                    text={displayLogText}
                    follow={logTailFollowBehavior.forceFollowing || follow}
                    onScroll={logTailFollowBehavior.forceFollowing ? undefined : onScroll}
                    enableSearch={false}
                    enableHotKeys={false}
                    enableLineNumbers={false}
                    selectableLines
                    wrapLines
                    extraLines={1}
                    rowHeight={24}
                    style={{
                      backgroundColor: "transparent",
                      color: "rgba(234,245,255,0.85)",
                      fontSize: "12px",
                      lineHeight: 1.45
                    }}
                    containerStyle={{
                      backgroundColor: "transparent",
                      padding: "0.75rem 1rem"
                    }}
                  />
                )}
              />
            ) : (
              <p className="p-4 text-xs leading-6 text-mist/70">No logs yet.</p>
            )}
          </div>
        </article>
      </section>

      <section className="reveal rounded-3xl border border-white/10 bg-panel/70 p-5 backdrop-blur" style={{ animationDelay: "200ms" }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-mist">Run History</h2>
            <p className="mt-1 text-xs text-mist/60">Times shown in your browser timezone: {browserTimeZone}</p>
          </div>
          <button
            onClick={() => void refresh()}
            className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent"
          >
            Refresh
          </button>
        </div>
        <div className="mt-4 grid gap-3 grid-cols-1">
          {runs.length === 0 ? (
            <p className="text-sm text-mist/70">No run artifacts yet.</p>
          ) : (
            runHistoryPagination.items.map((run, index) => {
              const report = projectRunHistoryReport(run);
              const artifacts = resolveRunArtifactPresence(run);
              const hotFileGovernance = run.hot_file_governance ?? run.evaluation?.hot_file_governance ?? null;
              const incompleteEvidence = artifacts.kind !== "full_bundle";
              const parsedTimestamp = parseRunTimestamp(run.timestamp);
              const displayTimestamp = formatRunTimestamp(run.timestamp);
              return (
                <article key={run.timestamp} className="rounded-2xl border border-white/10 bg-ink/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-mist/55">
                        Run {run.round !== undefined ? `#${run.round}` : `#${runHistoryPagination.startIndex + index + 1}`}
                      </p>
                      <p className="text-xs uppercase tracking-[0.2em] text-accent/80">
                        {parsedTimestamp ? displayTimestamp : run.timestamp}
                      </p>
                      <p className="mt-1 text-xs text-mist/55">Raw ID: {run.timestamp}</p>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.15em] ${
                        incompleteEvidence
                          ? "bg-warning/20 text-warning"
                          : report.decision === "pass"
                            ? "bg-accent/20 text-accent"
                            : report.decision === "fail"
                              ? "bg-ember/20 text-ember"
                              : "bg-slate/70 text-mist/80"
                      }`}
                    >
                      {incompleteEvidence ? "Incomplete evidence" : `Evaluator ${report.decision}`}
                    </span>
                  </div>

                  {hotFileGovernance ? (
                    <div className="mt-3">
                      <HotFileGovernancePanel signal={hotFileGovernance} compact />
                    </div>
                  ) : null}

                  {incompleteEvidence ? (
                    <>
                      <p className="mt-3 text-sm text-mist/90">
                        This round left reviewable evidence on disk before the full five-file bundle was completed.
                      </p>
                      <div className="mt-3 grid gap-2 text-xs text-mist/70 sm:grid-cols-2">
                        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">
                          Present: {formatArtifactPresenceList(artifacts.present)}
                        </p>
                        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">
                          Missing: {artifacts.missing.length > 0 ? formatArtifactPresenceList(artifacts.missing) : "none"}
                        </p>
                      </div>
                      <p className="mt-3 text-xs text-mist/65">
                        Available summary: {run.summary.trim() ? "yes" : "no"} | Metrics: {run.metrics ? "yes" : "no"} | Evaluation: {run.evaluation ? "yes" : "no"}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="mt-3 text-sm text-mist/90">
                        <span className="text-mist/60">Objective: </span>
                        {report.objective}
                      </p>
                      <p className="mt-2 text-sm text-mist/90">
                        <span className="text-mist/60">Expected: </span>
                        {report.expectedOutcome}
                      </p>
                      <p className="mt-2 text-sm text-mist/90">
                        <span className="text-mist/60">Summary: </span>
                        {report.workSummary}
                      </p>
                      <p className="mt-3 text-xs text-mist/75">
                        Tool: {report.toolStatus} | Error: {report.error}
                      </p>
                      <p className="mt-2 text-xs text-mist/65">Score: {report.aggregateScore}</p>
                      <p className="mt-2 text-xs text-mist/65">Why: {report.justification}</p>
                      {report.decision === "fail" && report.rootCause !== "none" ? (
                        <p className="mt-2 text-xs font-semibold text-ember">Root Cause: {report.rootCause}</p>
                      ) : null}
                      <p className="mt-2 text-xs text-mist/65">Evidence: {report.evidence}</p>
                      {report.dimensionBreakdown.length > 0 ? (
                        <div className="mt-3 grid gap-2 lg:grid-cols-2">
                          {report.dimensionBreakdown.map((dimension) => (
                            <div key={`${run.timestamp}-${dimension.label}`} className="rounded-xl border border-white/10 bg-ink/70 p-3">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mist/70">{dimension.label}</p>
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${dimension.decision === "pass"
                                    ? "bg-accent/20 text-accent"
                                    : dimension.decision === "fail"
                                      ? "bg-ember/20 text-ember"
                                      : "bg-slate/70 text-mist/80"
                                    }`}
                                >
                                  {dimension.decision}
                                </span>
                              </div>
                              <p className="mt-2 text-xs text-mist/65">
                                Score: {dimension.score} | Confidence: {dimension.confidence}
                              </p>
                              <p className="mt-2 text-xs text-mist/65">Why: {dimension.justification}</p>
                              <p className="mt-2 text-xs text-mist/60">Evidence: {dimension.evidence}</p>
                              <p className="mt-2 text-xs text-mist/60">Blocking: {dimension.blockingIssues}</p>
                              <p className="mt-2 text-xs text-mist/60">Next: {dimension.nextRecommendation}</p>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <p className="mt-2 text-xs text-mist/65">Next: {report.nextRecommendation}</p>
                      <div className="mt-3 grid gap-2 text-xs text-mist/70 sm:grid-cols-3">
                        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">Cost: {report.budgetCost}</p>
                        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">Time: {report.budgetTime}</p>
                        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">Actions: {report.budgetActions}</p>
                      </div>
                    </>
                  )}
                  <button
                    onClick={() => void fetchArtifacts(run)}
                    disabled={artifactsBusy}
                    className="mt-4 rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {artifactsBusy && selectedArtifacts?.timestamp === run.timestamp
                      ? "Loading..."
                      : incompleteEvidence
                        ? "Review Evidence"
                        : "Full Report"}
                  </button>
                </article>
              );
            })
          )}
        </div>
        {runs.length > 0 ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-mist/60">
              Page {runHistoryPagination.currentPage} / {runHistoryPagination.totalPages} · {RUN_HISTORY_PAGE_SIZE} per page
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRunHistoryPage((page) => Math.max(1, page - 1))}
                disabled={runHistoryPagination.currentPage <= 1}
                className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:border-white/10 disabled:text-mist/40"
              >
                Prev
              </button>
              <button
                onClick={() => setRunHistoryPage((page) => Math.min(runHistoryPagination.totalPages, page + 1))}
                disabled={runHistoryPagination.currentPage >= runHistoryPagination.totalPages}
                className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:border-white/10 disabled:text-mist/40"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {isGoalDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onClick={() => setIsGoalDialogOpen(false)}
          role="presentation"
        >
          <article
            className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-3xl border border-white/15 bg-panel/95 shadow-lift backdrop-blur"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-mist">Ultimate Goal</h3>
                <p className="mt-1 text-xs text-mist/60">Markdown 弹窗视图</p>
              </div>
              <button
                onClick={() => setIsGoalDialogOpen(false)}
                className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-ember hover:text-ember"
              >
                Close
              </button>
            </div>
            <div className="px-5 py-4">
              <GoalMarkdown
                goal={goal}
                containerClassName="max-h-[70vh] overflow-auto rounded-xl border border-white/10 bg-ink/60 p-4"
              />
            </div>
          </article>
        </div>
      ) : null}

      {selectedRole ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onClick={() => setSelectedRole(null)}
          role="presentation"
        >
          <article
            className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-3xl border border-white/15 bg-panel/95 shadow-lift backdrop-blur"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-mist">{selectedRole.title} Role Definition</h3>
                <p className="mt-1 text-xs text-mist/60">{selectedRole.path}</p>
              </div>
              <button
                onClick={() => setSelectedRole(null)}
                className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-ember hover:text-ember"
              >
                Close
              </button>
            </div>
            <div className="max-h-[75vh] overflow-auto px-5 py-4 text-sm text-mist/85">
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedRole.definition}</ReactMarkdown>
              </div>
            </div>
          </article>
        </div>
      ) : null}

      {selectedRequirement ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onClick={() => setSelectedRequirement(null)}
          role="presentation"
        >
          <article
            className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-3xl border border-white/15 bg-panel/95 shadow-lift backdrop-blur"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-mist">
                  {selectedRequirement.title || "Current Requirement"}
                </h3>
                <p className="mt-1 text-xs text-mist/60">{selectedRequirement.path}</p>
              </div>
              <button
                onClick={() => setSelectedRequirement(null)}
                className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-ember hover:text-ember"
              >
                Close
              </button>
            </div>
            <div className="max-h-[75vh] overflow-auto px-5 py-4 text-sm text-mist/85">
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {selectedRequirement.markdown || "_No active requirement markdown available._"}
                </ReactMarkdown>
              </div>
            </div>
          </article>
        </div>
      ) : null}

      {selectedArtifacts ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onClick={() => setSelectedArtifacts(null)}
          role="presentation"
        >
          <article
            className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-panel/95 shadow-lift backdrop-blur"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
              <div>
                <h3 className="text-xl font-bold text-mist">Run Artifact Bundle</h3>
                <p className="mt-1 text-xs uppercase tracking-widest text-accent/80">
                  {formatRunTimestamp(selectedArtifacts.timestamp)} · ID: {selectedArtifacts.timestamp}
                </p>
              </div>
              <button
                onClick={() => setSelectedArtifacts(null)}
                className="rounded-lg border border-white/20 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-mist/70 transition hover:border-ember hover:text-ember"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <div className="grid gap-6">
                <ArtifactPresenceCard artifacts={selectedArtifacts.artifacts} />

                <section>
                  <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">Summary Markdown</h4>
                  <div className="rounded-2xl border border-white/10 bg-ink/60 p-5 shadow-inner">
                    {selectedArtifacts.summary ? (
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedArtifacts.summary}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-sm text-mist/70">Summary artifact is missing for this round.</p>
                    )}
                  </div>
                </section>
                {selectedArtifacts.evaluation && selectedArtifactsReport ? (
                  <section>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">Evaluation</h4>
                    <div className="rounded-2xl border border-white/10 bg-ink/60 p-5 shadow-inner">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-mist/55">Evaluator Decision</p>
                          <p className="mt-2 text-sm text-mist/90">{selectedArtifactsReport.decision}</p>
                        </div>
                        <div className="grid gap-2 text-xs text-mist/70 sm:grid-cols-3">
                          <p className="rounded-lg border border-white/10 bg-ink/70 px-3 py-2">Score: {selectedArtifactsReport.aggregateScore}</p>
                          <p className="rounded-lg border border-white/10 bg-ink/70 px-3 py-2">Cost: {selectedArtifactsReport.budgetCost}</p>
                          <p className="rounded-lg border border-white/10 bg-ink/70 px-3 py-2">Actions: {selectedArtifactsReport.budgetActions}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-mist/85">Why: {selectedArtifactsReport.justification}</p>
                      {selectedArtifactsReport.decision === "fail" && selectedArtifactsReport.rootCause !== "none" ? (
                        <p className="mt-2 text-sm font-semibold text-ember">Root Cause: {selectedArtifactsReport.rootCause}</p>
                      ) : null}
                      <p className="mt-2 text-sm text-mist/75">Evidence: {selectedArtifactsReport.evidence}</p>
                      <RunArtifactEvidenceGrid report={selectedArtifactsReport} />
                      <p className="mt-2 text-sm text-mist/75">Next: {selectedArtifactsReport.nextRecommendation}</p>
                      {selectedArtifactsReport.dimensionBreakdown.length > 0 ? (
                        <div className="mt-4 grid gap-3 xl:grid-cols-2">
                          {selectedArtifactsReport.dimensionBreakdown.map((dimension) => (
                            <div key={`${selectedArtifacts.timestamp}-${dimension.label}`} className="rounded-xl border border-white/10 bg-ink/70 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mist/65">{dimension.label}</p>
                                  <p className="mt-2 text-xs text-mist/65">
                                    Score: {dimension.score} | Confidence: {dimension.confidence}
                                  </p>
                                </div>
                                <span
                                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${dimension.decision === "pass"
                                    ? "bg-accent/20 text-accent"
                                    : dimension.decision === "fail"
                                      ? "bg-ember/20 text-ember"
                                      : "bg-slate/70 text-mist/80"
                                    }`}
                                >
                                  {dimension.decision}
                                </span>
                              </div>
                              <p className="mt-3 text-sm text-mist/85">Why: {dimension.justification}</p>
                              <p className="mt-2 text-xs text-mist/65">Evidence: {dimension.evidence}</p>
                              <p className="mt-2 text-xs text-mist/65">Blocking: {dimension.blockingIssues}</p>
                              <p className="mt-2 text-xs text-mist/65">Next: {dimension.nextRecommendation}</p>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </section>
                ) : null}

                <section>
                  <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">Current Requirement Snapshot</h4>
                  <RequirementSnapshotCard
                    artifact={selectedArtifacts.active_requirement}
                    onOpen={() => {
                      if (selectedArtifacts.active_requirement?.exists) {
                        setSelectedRequirement(selectedArtifacts.active_requirement);
                      }
                    }}
                  />
                </section>

                {selectedGovernance && (
                  <section>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">Governance Lifecycle</h4>
                    <div className="rounded-2xl border border-white/10 bg-ink/60 p-6 shadow-inner">
                      <div className="flex flex-col gap-6 relative before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[1px] before:bg-white/10">
                        
                        {/* Tactical Step */}
                        <div className="relative pl-8">
                          <span className="absolute left-0 top-1 h-6 w-6 rounded-full border border-white/20 bg-ink flex items-center justify-center">
                            <span className="h-2 w-2 rounded-full bg-accent" />
                          </span>
                          <p className="text-xs font-bold uppercase tracking-widest text-mist/80">1. Tactical Execution</p>
                          <p className="mt-1 text-xs text-mist/60">Executor attempted the sub-task using specified tools.</p>
                        </div>

                        {/* Evaluation Step */}
                        <div className="relative pl-8">
                          <span className={`absolute left-0 top-1 h-6 w-6 rounded-full border border-white/20 bg-ink flex items-center justify-center`}>
                            <span className={`h-2 w-2 rounded-full ${selectedArtifactsReport?.decision === 'pass' ? 'bg-accent' : 'bg-ember'}`} />
                          </span>
                          <p className="text-xs font-bold uppercase tracking-widest text-mist/80">2. Evaluation: {selectedArtifactsReport?.decision.toUpperCase() || 'UNKNOWN'}</p>
                          <p className="mt-1 text-xs text-mist/60">{selectedArtifactsReport?.justification}</p>
                          {selectedGovernance.hot_file_governance ? (
                            <div className="mt-4">
                              <HotFileGovernancePanel signal={selectedGovernance.hot_file_governance} compact />
                            </div>
                          ) : null}
                        </div>

                        {/* Leader Step */}
                        {selectedGovernance.leader && (
                          <div className="relative pl-8">
                            <span className="absolute left-0 top-1 h-6 w-6 rounded-full border border-white/20 bg-ink flex items-center justify-center">
                              <span className="h-2 w-2 rounded-full bg-warning" />
                            </span>
                            <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 shadow-sm">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-bold uppercase tracking-widest text-warning/90">3. Leader Diagnosis: {selectedGovernance.leader.diagnosis_type.replace('_', ' ')}</p>
                                <span className="rounded bg-warning/20 px-2 py-0.5 text-[10px] text-warning uppercase font-bold tracking-tighter">Action: {selectedGovernance.leader.action}</span>
                              </div>
                              <p className="mt-3 text-sm text-mist/90 italic leading-relaxed">"{selectedGovernance.leader.rationale}"</p>
                              {selectedGovernance.leader.instructions && selectedGovernance.leader.instructions.length > 0 && (
                                <div className="mt-4 pt-3 border-t border-warning/20">
                                  <p className="text-[10px] uppercase tracking-widest text-mist/50 font-bold">Strategic Recovery Instructions:</p>
                                  <ul className="mt-2 space-y-2">
                                    {selectedGovernance.leader.instructions.map((inst: string, i: number) => (
                                      <li key={i} className="flex items-start gap-2 text-xs text-mist/80">
                                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warning/40" />
                                        {inst}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              </div>
                              </div>
                              )}

                              {/* CCB Step */}
                              {selectedGovernance.ccb && (
                              <div className="relative pl-8">
                              <span className="absolute left-0 top-1 h-6 w-6 rounded-full border border-white/20 bg-ink flex items-center justify-center">
                              <span className="h-2 w-2 rounded-full bg-sky-400" />
                              </span>
                              <div className="rounded-xl border border-sky-400/30 bg-sky-400/5 p-4 shadow-sm">
                              <p className="text-xs font-bold uppercase tracking-widest text-sky-400/90">4. CCB Expert Consensus</p>
                              <div className="mt-3">
                                <p className="text-[10px] uppercase tracking-widest text-mist/50 font-bold">Proposed Constitutional Modification:</p>
                                <div className="mt-2 rounded-lg border border-white/5 bg-ink/40 p-3 text-xs text-mist/70 font-mono leading-relaxed">
                                  {selectedGovernance.ccb.proposed_change}
                                </div>
                              </div>

                              {selectedGovernance.ccb.experts && selectedGovernance.ccb.experts.length > 0 && (
                                <div className="mt-5 grid gap-4 md:grid-cols-3">
                                  {selectedGovernance.ccb.experts.map((expert: ExpertOpinion, i: number) => (
                                    <div key={i} className="rounded-xl border border-white/5 bg-ink/60 p-3 shadow-inner">
                                      <div className="flex items-center justify-between">
                                        <p className="text-[10px] uppercase tracking-widest text-mist/40 font-bold">{expert.expert_role.replace('_', ' ')}</p>
                                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase ${expert.vote === 'approve' ? 'bg-accent/20 text-accent' : 'bg-ember/20 text-ember'}`}>
                                          {expert.vote}
                                        </span>
                                      </div>
                                      <p className="mt-2 text-[11px] text-mist/70 leading-relaxed italic" title={expert.rationale}>
                                        "{expert.rationale}"
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="mt-5 flex items-center justify-between border-t border-sky-400/20 pt-4">
                                <div className="flex items-center gap-2">
                                  <span className={`h-2 w-2 rounded-full ${selectedGovernance.ccb.final_decision === 'approve' ? 'bg-accent' : 'bg-ember'}`} />
                                  <p className="text-xs font-bold text-mist/90 uppercase tracking-widest">Final Decision:</p>
                                </div>
                                <span className={`rounded-lg px-4 py-1 text-xs font-black uppercase tracking-[0.2em] ${selectedGovernance.ccb.final_decision === 'approve' ? 'bg-accent text-ink shadow-[0_0_12px_rgba(102,255,187,0.4)]' : 'bg-ember text-mist'}`}>
                                  {selectedGovernance.ccb.final_decision}
                                </span>
                              </div>
                            </div>
                          </div>
                        )}

                      </div>
                    </div>
                  </section>
                )}

                <div className="grid gap-6 lg:grid-cols-2">
                  <section>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">Round Log</h4>
                    <div className="h-[30rem] overflow-auto rounded-2xl border border-white/10 bg-ink/80 p-4 font-mono text-xs leading-relaxed text-mist/80 shadow-inner">
                      {selectedArtifacts.log ? (
                        <pre className="whitespace-pre-wrap">{selectedArtifacts.log}</pre>
                      ) : (
                        <p className="text-sm text-mist/60">Log artifact is missing for this round.</p>
                      )}
                    </div>
                  </section>
                  <section>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">State Change</h4>
                    <div className="h-[30rem] overflow-auto rounded-2xl border border-white/10 bg-ink/80 p-4 font-mono text-xs leading-relaxed text-mist/80 shadow-inner">
                      {selectedArtifacts.state_change ? (
                        <pre className="whitespace-pre-wrap">{selectedArtifacts.state_change}</pre>
                      ) : (
                        <p className="text-sm text-mist/60">State change artifact is missing for this round.</p>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </article>
        </div>
      ) : null}

      {selectedRun ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onClick={() => setSelectedRun(null)}
          role="presentation"
        >
          <article
            className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-3xl border border-white/15 bg-panel/95 shadow-lift backdrop-blur"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-mist">Full Report</h3>
                <p className="mt-1 text-xs text-mist/60">{formatRunTimestamp(selectedRun.timestamp)}</p>
              </div>
              <button
                onClick={() => setSelectedRun(null)}
                className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-ember hover:text-ember"
              >
                Close
              </button>
            </div>
            <div className="max-h-[75vh] overflow-auto px-5 py-4 text-sm text-mist/85">
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedRun.summary}</ReactMarkdown>
              </div>
            </div>
          </article>
        </div>
      ) : null}
    </main>
  );
}
