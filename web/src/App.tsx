import { useEffect, useMemo, useState } from "react";
import { LazyLog, ScrollFollow } from "@melloware/react-logviewer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildLogViewerText } from "./log-lines";
import { resolveLogTailFollowBehavior } from "./log-follow";
import { GoalMarkdown } from "./goal-markdown";
import { deriveRoundProgress } from "./round-progress";
import { projectRunHistoryReport, type RunHistoryItem, type GovernanceDetails, type ExpertOpinion } from "./run-history";
import { paginateRunHistory, RUN_HISTORY_PAGE_SIZE } from "./run-history-pagination";

type LoopStateName = "idle" | "starting" | "running" | "cooldown" | "paused" | "stopping" | "error";

interface LoopStatus {
  state: LoopStateName;
  round: number;
  pid: number | null;
  pid_alive: boolean;
  last_error: string | null;
  updated_at: string;
  consecutive_evaluator_failures: number;
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

type ProjectRoleName = "planner" | "executor" | "evaluator";

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
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function isUnauthorizedError(message: string): boolean {
  return message.includes("Unauthorized");
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "0s";
  }
  return `${Math.round(ms / 1000)}s`;
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
  summary: string;
  metrics: Record<string, unknown> | null;
  log: string;
  state_change: string;
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
  const [selectedGovernance, setSelectedGovernance] = useState<GovernanceDetails | null>(null);
  const [artifactsBusy, setArtifactsBusy] = useState(false);
  const [runHistoryPage, setRunHistoryPage] = useState(1);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeLoopConfig | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
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
      { key: "planner", title: "Planner", description: "生成本轮子任务" },
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

  const budgetBars = useMemo(() => {
    if (!status?.current_budget) {
      return [];
    }

    const { limits, usage } = status.current_budget;
    return [
      {
        label: "USD",
        used: usage.usdUsed,
        limit: limits.usdPerRound,
        display: `${usage.usdUsed.toFixed(4)} / ${limits.usdPerRound}`
      },
      {
        label: "Actions",
        used: usage.actionsUsed,
        limit: limits.actions,
        display: `${usage.actionsUsed} / ${limits.actions}`
      },
      {
        label: "Time",
        used: usage.elapsedMs,
        limit: limits.timeMinutes * 60_000,
        display: `${formatMs(usage.elapsedMs)} / ${limits.timeMinutes}m`
      }
    ];
  }, [status]);

  const controlAvailability = useMemo(() => {
    const state = status?.state;
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
      canPause: state === "running" || state === "cooldown",
      canResume: state === "paused",
      canStop: state === "starting" || state === "running" || state === "cooldown" || state === "paused"
    };
  }, [status?.state]);

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
      summary: selectedArtifacts.summary,
      metrics: selectedArtifacts.metrics,
      evaluation: selectedArtifacts.evaluation
    });
  }, [selectedArtifacts]);

  useEffect(() => {
    if (runHistoryPagination.currentPage !== runHistoryPage) {
      setRunHistoryPage(runHistoryPagination.currentPage);
    }
  }, [runHistoryPage, runHistoryPagination.currentPage]);

  const sendControl = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    try {
      setBusy(path);
      await api(path, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      }, authToken);
      await refresh();
    } catch (requestError) {
      handleRequestError(requestError, "控制操作失败：请先重新登录。");
    } finally {
      if (busy === path || busy === null || true) {
        setBusy(null);
      }
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
    setRuntimeConfig(null);
    setAuthError(null);
    setError(null);
  };

  const submitInstruction = async (): Promise<void> => {
    const trimmed = instruction.trim();
    if (!trimmed) {
      return;
    }
    await sendControl("/api/loop/instruct", { message: trimmed });
    setInstruction("");
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
      const [bundle, governance] = await Promise.all([
        api<RunArtifactBundle>(`/api/runs/${run.timestamp}/artifacts`, undefined, authToken),
        run.has_governance ? api<GovernanceDetails>(`/api/runs/${run.round}/governance`, undefined, authToken).catch(() => null) : Promise.resolve(null)
      ]);
      setSelectedArtifacts({
        ...bundle,
        timestamp: run.timestamp,
        summary: run.summary,
        metrics: run.metrics,
        evaluation: run.evaluation
      });
      setSelectedGovernance(governance);
      setError(null);
    } catch (requestError) {
      handleRequestError(requestError, "无法获取运行详情：请重试或重新登录。");
    } finally {
      setArtifactsBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedRun && !selectedArtifacts && !selectedRole && !isGoalDialogOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSelectedRun(null);
        setSelectedArtifacts(null);
        setSelectedRole(null);
        setIsGoalDialogOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedRun, selectedArtifacts, selectedRole, isGoalDialogOpen]);

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

        <div className="mt-5 grid gap-3 text-sm text-mist/80 md:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-ink/60 p-3">Round: {status?.round ?? "-"}</div>
          <div className="rounded-xl border border-white/10 bg-ink/60 p-3">PID: {status?.pid ?? "-"}</div>
          <div className="rounded-xl border border-white/10 bg-ink/60 p-3">
            Process: {status?.pid_alive ? "alive" : "not running"}
          </div>
          <div className="rounded-xl border border-white/10 bg-ink/60 p-3">
            Evaluator failures: {status?.consecutive_evaluator_failures ?? 0}
          </div>
        </div>

        {frictionIndex && (
          <div className="mt-4 rounded-xl border border-white/10 bg-ink/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-[0.2em] text-mist/70">System Health (Friction Index)</p>
              <span className={`h-2 w-2 rounded-full ${frictionIndex.healthStatus === 'healthy' ? 'bg-accent shadow-[0_0_8px_rgba(102,255,187,0.6)]' : 'bg-ember animate-pulse shadow-[0_0_8px_rgba(255,102,102,0.6)]'}`} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-mist/50">Rework Churn</p>
                <p className={`text-lg font-bold ${(frictionIndex.reworkChurnRate > 0.4) ? 'text-ember' : 'text-mist'}`}>
                  {(frictionIndex.reworkChurnRate * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-mist/50">Avg Actions</p>
                <p className={`text-lg font-bold ${(frictionIndex.averageActions > 50) ? 'text-warning' : 'text-mist'}`}>
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
            </div>
          </div>
        )}

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

        <div className="mt-6 grid gap-2 md:grid-cols-4">
          <button
            className="rounded-xl flex items-center justify-center gap-2 bg-accent px-4 py-2 font-semibold text-ink transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-accent/40"
            onClick={() => void sendControl("/api/loop/start")}
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
            onClick={() => void sendControl("/api/loop/pause")}
            disabled={busy !== null || configBusy || !controlAvailability.canPause}
          >
            Pause
          </button>
          <button
            className="rounded-xl bg-sky-300 px-4 py-2 font-semibold text-ink transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:bg-sky-200/50"
            onClick={() => void sendControl("/api/loop/resume")}
            disabled={busy !== null || configBusy || !controlAvailability.canResume}
          >
            Resume
          </button>
          <button
            className="rounded-xl bg-ember px-4 py-2 font-semibold text-ink transition hover:bg-ember/80 disabled:cursor-not-allowed disabled:bg-ember/40"
            onClick={() => void sendControl("/api/loop/stop")}
            disabled={busy !== null || configBusy || !controlAvailability.canStop}
          >
            Stop
          </button>
        </div>
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
              Codex Model
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
              Codex Profile
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
              Planner Sandbox
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
              Codex Timeout (ms)
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
          <h2 className="text-lg font-semibold text-mist">Budgets</h2>
          <div className="mt-4 space-y-4">
            {budgetBars.length === 0 ? (
              <p className="text-sm text-mist/70">No budget usage yet.</p>
            ) : (
              budgetBars.map((bar) => {
                const ratio = bar.limit > 0 ? Math.min(100, (bar.used / bar.limit) * 100) : 0;
                return (
                  <div key={bar.label}>
                    <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-mist/70">
                      <span>{bar.label}</span>
                      <span>{bar.display}</span>
                    </div>
                    <div className="h-2 rounded-full bg-ink/70">
                      <div
                        className="h-2 rounded-full bg-gradient-to-r from-accent via-warning to-ember"
                        style={{ width: `${ratio}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>

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
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.15em] ${report.decision === "pass"
                        ? "bg-accent/20 text-accent"
                        : report.decision === "fail"
                          ? "bg-ember/20 text-ember"
                          : "bg-slate/70 text-mist/80"
                        }`}
                    >
                      Evaluator {report.decision}
                    </span>
                  </div>

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
                  <button
                    onClick={() => void fetchArtifacts(run)}
                    disabled={artifactsBusy}
                    className="mt-4 rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {artifactsBusy && selectedArtifacts?.timestamp === run.timestamp ? "Loading..." : "Full Report"}
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
                <section>
                  <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">Summary</h4>
                  <div className="rounded-2xl border border-white/10 bg-ink/60 p-5 shadow-inner">
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedArtifacts.summary}</ReactMarkdown>
                    </div>
                  </div>
                </section>
                {selectedArtifactsReport ? (
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
                              {selectedGovernance.leader.instructions.length > 0 && (
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
                      <pre className="whitespace-pre-wrap">{selectedArtifacts.log}</pre>
                    </div>
                  </section>
                  <section>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-widest text-mist/50">State Change</h4>
                    <div className="h-[30rem] overflow-auto rounded-2xl border border-white/10 bg-ink/80 p-4 font-mono text-xs leading-relaxed text-mist/80 shadow-inner">
                      <pre className="whitespace-pre-wrap">{selectedArtifacts.state_change}</pre>
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
