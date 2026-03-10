import fs from "node:fs";
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
  enableLeader: boolean;
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

interface LoadConfigOptions {
  cwd?: string;
}

function readDotEnvFile(cwd: string): Record<string, string> {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const parsed: Record<string, string> = {};
  const raw = fs.readFileSync(envPath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    parsed[key] = value;
  }

  return parsed;
}

function resolveEnvValue(
  env: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
  key: string
): string | undefined {
  const runtimeValue = env[key];
  if (runtimeValue !== undefined) {
    return runtimeValue;
  }
  return fileEnv[key];
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

export function resolveCodexBin(
  config: CodexConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const sharedOverride = env.AILOOP_CODEX_BIN?.trim();
  if (sharedOverride) {
    return sharedOverride;
  }

  const configuredBin = config.bin.trim();
  const defaultBin = "codex";
  if (configuredBin && configuredBin !== defaultBin) {
    return configuredBin;
  }

  return configuredBin || defaultBin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): AppConfig {
  const fileEnv = readDotEnvFile(options.cwd ?? process.cwd());
  const get = (key: string): string | undefined => resolveEnvValue(env, fileEnv, key);

  const homeDir = path.resolve(get("AILOOP_HOME") ?? "./.ailoop");
  const intervalSeconds = parseNumber(get("AILOOP_INTERVAL_SECONDS"), 1200);
  const maxCycles = parseNumber(get("AILOOP_MAX_CYCLES"), 0);
  const exitOnError = (get("AILOOP_EXIT_ON_ERROR") ?? "0") === "1";
  const enableLeader = (get("AILOOP_ENABLE_LEADER") ?? "0") === "1";
  const evaluatorReworkMaxAttempts = Math.max(
    0,
    Math.min(5, Math.round(parseNumber(get("AILOOP_EVAL_REWORK_MAX_ATTEMPTS"), 1)))
  );
  const consoleHost = get("AILOOP_CONSOLE_HOST") ?? "0.0.0.0";
  const consolePort = parseNumber(get("AILOOP_CONSOLE_PORT"), 3090);
  const consoleAdminToken = get("AILOOP_CONSOLE_ADMIN_TOKEN") ?? "";
  const maxRetainRuns = parseNumber(get("AILOOP_MAX_RETAIN_RUNS"), 50);

  const evaluatorTypeRaw = (get("AILOOP_EVALUATOR_TYPE") ?? "llm") as EvaluatorType;
  const evaluatorType: EvaluatorType = ["shell", "llm", "webhook"].includes(evaluatorTypeRaw)
    ? evaluatorTypeRaw
    : "shell";

  return {
    homeDir,
    intervalSeconds,
    maxCycles,
    exitOnError,
    enableLeader,
    evaluatorReworkMaxAttempts,
    consoleHost,
    consolePort,
    consoleAdminToken,
    maxRetainRuns,
    budget: {
      usdPerRound: parseNumber(get("AILOOP_BUDGET_USD_PER_ROUND"), 0.5),
      timeMinutes: parseNumber(get("AILOOP_BUDGET_TIME_MINUTES"), 60),
      actions: parseNumber(get("AILOOP_BUDGET_ACTIONS"), 30)
    },
    evaluatorType,
    evaluatorCmd: get("AILOOP_EVALUATOR_CMD") ?? "",
    webhookEvaluatorUrl: get("AILOOP_WEBHOOK_EVALUATOR_URL") ?? "",
    codex: {
      bin: get("AILOOP_CODEX_BIN") ?? "codex",
      model: get("AILOOP_CODEX_MODEL") ?? "",
      profile: get("AILOOP_CODEX_PROFILE") ?? "",
      plannerSandbox: parseSandboxMode(get("AILOOP_CODEX_PLANNER_SANDBOX"), "read-only"),
      executorSandbox: parseSandboxMode(get("AILOOP_CODEX_EXECUTOR_SANDBOX"), "danger-full-access"),
      evaluatorSandbox: parseSandboxMode(get("AILOOP_CODEX_EVALUATOR_SANDBOX"), "danger-full-access"),
      timeoutMs: parseNumber(get("AILOOP_CODEX_TIMEOUT_MS"), 180_000),
      llmEvaluatorDimensions: parseLlmEvaluatorDimensions(get("AILOOP_LLM_EVALUATOR_DIMENSIONS")),
      llmEvaluatorMinPassScore: Math.max(
        0,
        Math.min(100, parseNumber(get("AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE"), 75))
      )
    }
  };
}
