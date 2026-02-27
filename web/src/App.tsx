import { useEffect, useMemo, useState } from "react";

type LoopStateName = "idle" | "running" | "paused" | "stopping" | "error";

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

interface RunItem {
  timestamp: string;
  summary: string;
  metrics: Record<string, unknown> | null;
}

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type EvaluatorType = "shell" | "llm" | "webhook";

interface RuntimeLoopConfig {
  intervalSeconds: number;
  maxCycles: number;
  exitOnError: boolean;
  budget: {
    usdPerRound: number;
    timeMinutes: number;
    actions: number;
  };
  evaluatorType: EvaluatorType;
  evaluatorCmd: string;
  webhookEvaluatorUrl: string;
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

const stateTone: Record<LoopStateName, string> = {
  idle: "bg-slate text-mist",
  running: "bg-accent/20 text-accent",
  paused: "bg-warning/20 text-warning",
  stopping: "bg-ember/20 text-ember",
  error: "bg-red-500/20 text-red-300"
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "0s";
  }
  return `${Math.round(ms / 1000)}s`;
}

function extractSummaryLine(summary: string): string {
  const line = summary
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("- Objective:"));
  return line ? line.replace("- Objective:", "").trim() : "No objective captured";
}

export default function App() {
  const [status, setStatus] = useState<LoopStatus | null>(null);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeLoopConfig | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [nextStatus, nextRuns, nextLogs] = await Promise.all([
        api<LoopStatus>("/api/status"),
        api<RunItem[]>("/api/runs?limit=20"),
        api<{ lines: string[] }>("/api/logs/tail?lines=120")
      ]);
      setStatus(nextStatus);
      setRuns(nextRuns);
      setLogs(nextLogs.lines);
      setError(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  const refreshRuntimeConfig = async (): Promise<void> => {
    try {
      const next = await api<RuntimeLoopConfig>("/api/config");
      setRuntimeConfig(next);
      setError(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    void refreshRuntimeConfig();
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, []);

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

  const sendControl = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    try {
      setBusy(true);
      await api(path, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      });
      await refresh();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
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
      });
      setRuntimeConfig(response.config);
      setError(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setConfigBusy(false);
    }
  };

  const resetRuntimeConfig = async (): Promise<void> => {
    try {
      setConfigBusy(true);
      const response = await api<SaveConfigResponse>("/api/config/reset", {
        method: "POST"
      });
      setRuntimeConfig(response.config);
      setError(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setConfigBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <section className="reveal rounded-3xl border border-white/10 bg-panel/80 p-6 shadow-lift backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-accent/80">AutoLoop Control Plane</p>
            <h1 className="mt-1 text-3xl font-bold text-mist md:text-4xl">Autonomy Dashboard</h1>
          </div>
          <span
            className={`rounded-full px-4 py-2 text-sm font-semibold uppercase tracking-[0.2em] ${
              status ? stateTone[status.state] : "bg-slate text-mist"
            }`}
          >
            {status?.state ?? "loading"}
          </span>
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

        <div className="mt-6 grid gap-2 md:grid-cols-4">
          <button
            className="rounded-xl bg-accent px-4 py-2 font-semibold text-ink transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-accent/40"
            onClick={() => void sendControl("/api/loop/start")}
            disabled={busy || configBusy}
          >
            Start
          </button>
          <button
            className="rounded-xl bg-warning px-4 py-2 font-semibold text-ink transition hover:bg-warning/80 disabled:cursor-not-allowed disabled:bg-warning/40"
            onClick={() => void sendControl("/api/loop/pause")}
            disabled={busy || configBusy}
          >
            Pause
          </button>
          <button
            className="rounded-xl bg-sky-300 px-4 py-2 font-semibold text-ink transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:bg-sky-200/50"
            onClick={() => void sendControl("/api/loop/resume")}
            disabled={busy || configBusy}
          >
            Resume
          </button>
          <button
            className="rounded-xl bg-ember px-4 py-2 font-semibold text-ink transition hover:bg-ember/80 disabled:cursor-not-allowed disabled:bg-ember/40"
            onClick={() => void sendControl("/api/loop/stop")}
            disabled={busy || configBusy}
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
              disabled={configBusy || busy}
              className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-warning hover:text-warning disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset
            </button>
            <button
              onClick={() => void saveRuntimeConfig()}
              disabled={!runtimeConfig || configBusy || busy}
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
              Max Cycles (0 = unlimited)
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
              Evaluator Type
              <select
                value={runtimeConfig.evaluatorType}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    evaluatorType: event.target.value as EvaluatorType
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              >
                <option value="llm">llm</option>
                <option value="shell">shell</option>
                <option value="webhook">webhook</option>
              </select>
            </label>
            <label className="text-sm text-mist/80">
              Evaluator Command (shell mode)
              <input
                value={runtimeConfig.evaluatorCmd}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    evaluatorCmd: event.target.value
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
            </label>
            <label className="text-sm text-mist/80 md:col-span-2">
              Webhook Evaluator URL
              <input
                value={runtimeConfig.webhookEvaluatorUrl}
                onChange={(event) =>
                  setRuntimeConfig({
                    ...runtimeConfig,
                    webhookEvaluatorUrl: event.target.value
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/15 bg-ink/80 px-3 py-2 text-mist outline-none ring-accent/40 focus:ring"
              />
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

      <section className="reveal grid gap-6 md:grid-cols-[1.1fr_0.9fr]" style={{ animationDelay: "120ms" }}>
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
              disabled={busy}
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
          <pre className="mt-4 max-h-[22rem] overflow-auto rounded-xl border border-white/10 bg-ink/75 p-4 text-xs leading-6 text-mist/80">
            {logs.length > 0 ? logs.join("\n") : "No logs yet."}
          </pre>
        </article>
      </section>

      <section className="reveal rounded-3xl border border-white/10 bg-panel/70 p-5 backdrop-blur" style={{ animationDelay: "200ms" }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-mist">Run History</h2>
          <button
            onClick={() => void refresh()}
            className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent"
          >
            Refresh
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {runs.length === 0 ? (
            <p className="text-sm text-mist/70">No run artifacts yet.</p>
          ) : (
            runs.map((run) => (
              <article key={run.timestamp} className="rounded-2xl border border-white/10 bg-ink/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-accent/80">{run.timestamp}</p>
                <p className="mt-2 text-sm text-mist/85">{extractSummaryLine(run.summary)}</p>
                <p className="mt-2 text-xs text-mist/55">{run.metrics ? JSON.stringify(run.metrics) : "No metrics"}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
