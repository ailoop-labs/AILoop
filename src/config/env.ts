import path from "node:path";
import type { BudgetLimits, EvaluatorType } from "../types/contracts";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexConfig {
  bin: string;
  model: string;
  profile: string;
  plannerSandbox: CodexSandboxMode;
  executorSandbox: CodexSandboxMode;
  evaluatorSandbox: CodexSandboxMode;
  timeoutMs: number;
}

export interface AppConfig {
  homeDir: string;
  intervalSeconds: number;
  maxCycles: number;
  exitOnError: boolean;
  consoleHost: string;
  consolePort: number;
  maxRetainRuns: number;
  budget: BudgetLimits;
  evaluatorType: EvaluatorType;
  evaluatorCmd: string;
  webhookEvaluatorUrl: string;
  codex: CodexConfig;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return fallback;
}

function parseSandboxMode(value: string | undefined, fallback: CodexSandboxMode): CodexSandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const homeDir = path.resolve(env.AUTOLOOP_HOME ?? "./.autoloop");
  const intervalSeconds = parseNumber(env.AUTOLOOP_INTERVAL_SECONDS, 1200);
  const maxCycles = parseNumber(env.AUTOLOOP_MAX_CYCLES, 0);
  const exitOnError = (env.AUTOLOOP_EXIT_ON_ERROR ?? "0") === "1";
  const consoleHost = env.AUTOLOOP_CONSOLE_HOST ?? "0.0.0.0";
  const consolePort = parseNumber(env.AUTOLOOP_CONSOLE_PORT, 3090);
  const maxRetainRuns = parseNumber(env.AUTOLOOP_MAX_RETAIN_RUNS, 50);

  const evaluatorTypeRaw = (env.AUTOLOOP_EVALUATOR_TYPE ?? "llm") as EvaluatorType;
  const evaluatorType: EvaluatorType = ["shell", "llm", "webhook"].includes(evaluatorTypeRaw)
    ? evaluatorTypeRaw
    : "shell";

  return {
    homeDir,
    intervalSeconds,
    maxCycles,
    exitOnError,
    consoleHost,
    consolePort,
    maxRetainRuns,
    budget: {
      usdPerRound: parseNumber(env.AUTOLOOP_BUDGET_USD_PER_ROUND, 0.5),
      timeMinutes: parseNumber(env.AUTOLOOP_BUDGET_TIME_MINUTES, 15),
      actions: parseNumber(env.AUTOLOOP_BUDGET_ACTIONS, 30)
    },
    evaluatorType,
    evaluatorCmd: env.AUTOLOOP_EVALUATOR_CMD ?? "",
    webhookEvaluatorUrl: env.AUTOLOOP_WEBHOOK_EVALUATOR_URL ?? "",
    codex: {
      bin: env.AUTOLOOP_CODEX_BIN ?? "codex",
      model: env.AUTOLOOP_CODEX_MODEL ?? "",
      profile: env.AUTOLOOP_CODEX_PROFILE ?? "",
      plannerSandbox: parseSandboxMode(env.AUTOLOOP_CODEX_PLANNER_SANDBOX, "read-only"),
      executorSandbox: parseSandboxMode(env.AUTOLOOP_CODEX_EXECUTOR_SANDBOX, "danger-full-access"),
      evaluatorSandbox: parseSandboxMode(env.AUTOLOOP_CODEX_EVALUATOR_SANDBOX, "danger-full-access"),
      timeoutMs: parseNumber(env.AUTOLOOP_CODEX_TIMEOUT_MS, 180_000)
    }
  };
}
