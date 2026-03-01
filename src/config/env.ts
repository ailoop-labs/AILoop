import path from "node:path";
import type { BudgetLimits, EvaluationDimension, EvaluatorType } from "../types/contracts";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export const DEFAULT_LLM_EVALUATOR_DIMENSIONS: EvaluationDimension[] = [
  "goal_alignment",
  "causal_validity",
  "constraint_compliance",
  "risk_externality",
  "reversibility_resilience",
  "learning_yield"
];
const VALID_EVALUATION_DIMENSIONS = new Set<EvaluationDimension>(DEFAULT_LLM_EVALUATOR_DIMENSIONS);

export interface CodexConfig {
  bin: string;
  model: string;
  profile: string;
  plannerSandbox: CodexSandboxMode;
  executorSandbox: CodexSandboxMode;
  evaluatorSandbox: CodexSandboxMode;
  timeoutMs: number;
  llmEvaluatorDimensions: EvaluationDimension[];
  llmEvaluatorMinPassScore: number;
}

export interface AppConfig {
  homeDir: string;
  intervalSeconds: number;
  maxCycles: number;
  exitOnError: boolean;
  evaluatorReworkMaxAttempts: number;
  consoleHost: string;
  consolePort: number;
  consoleAdminToken: string;
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

function parseLlmEvaluatorDimensions(value: string | undefined): EvaluationDimension[] {
  if (!value || !value.trim()) {
    return [...DEFAULT_LLM_EVALUATOR_DIMENSIONS];
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is EvaluationDimension => VALID_EVALUATION_DIMENSIONS.has(item as EvaluationDimension));

  if (parsed.length === 0) {
    return [...DEFAULT_LLM_EVALUATOR_DIMENSIONS];
  }

  return Array.from(new Set(parsed));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const homeDir = path.resolve(env.AUTOLOOP_HOME ?? "./.autoloop");
  const intervalSeconds = parseNumber(env.AUTOLOOP_INTERVAL_SECONDS, 1200);
  const maxCycles = parseNumber(env.AUTOLOOP_MAX_CYCLES, 0);
  const exitOnError = (env.AUTOLOOP_EXIT_ON_ERROR ?? "0") === "1";
  const evaluatorReworkMaxAttempts = Math.max(0, Math.min(5, Math.round(parseNumber(env.AUTOLOOP_EVAL_REWORK_MAX_ATTEMPTS, 1))));
  const consoleHost = env.AUTOLOOP_CONSOLE_HOST ?? "0.0.0.0";
  const consolePort = parseNumber(env.AUTOLOOP_CONSOLE_PORT, 3090);
  const consoleAdminToken = env.AUTOLOOP_CONSOLE_ADMIN_TOKEN ?? "";
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
    evaluatorReworkMaxAttempts,
    consoleHost,
    consolePort,
    consoleAdminToken,
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
      timeoutMs: parseNumber(env.AUTOLOOP_CODEX_TIMEOUT_MS, 180_000),
      llmEvaluatorDimensions: parseLlmEvaluatorDimensions(env.AUTOLOOP_LLM_EVALUATOR_DIMENSIONS),
      llmEvaluatorMinPassScore: Math.max(0, Math.min(100, parseNumber(env.AUTOLOOP_LLM_EVALUATOR_MIN_PASS_SCORE, 75)))
    }
  };
}
