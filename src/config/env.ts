import path from "node:path";
import { hydrateEnvFromShell } from "../utils/env";
import type { BudgetLimits, EvaluationDimension } from "../types/contracts";
import type { DatabaseManager } from "../utils/db";

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

async function getConfigValue(
  key: string,
  env: NodeJS.ProcessEnv,
  db?: DatabaseManager
): Promise<string | undefined> {
  // Priority: 1. Database, 2. Environment variable
  if (db) {
    const dbValue = await db.getConfig(key);
    if (dbValue !== null) {
      return dbValue;
    }
  }
  return env[key];
}

export async function loadConfigAsync(
  env: NodeJS.ProcessEnv = process.env,
  db?: DatabaseManager
): Promise<AppConfig> {
  if (env === process.env) {
    hydrateEnvFromShell();
  }

  const get = async (key: string): Promise<string | undefined> => {
    return await getConfigValue(key, env, db);
  };

  const homeDir = path.resolve((await get("AILOOP_HOME")) ?? "./.ailoop");
  const intervalSeconds = parseNumber(await get("AILOOP_INTERVAL_SECONDS"), 1200);
  const maxCycles = parseNumber(await get("AILOOP_MAX_CYCLES"), 0);
  const exitOnError = ((await get("AILOOP_EXIT_ON_ERROR")) ?? "0") === "1";
  const evaluatorReworkMaxAttempts = Math.max(
    0,
    Math.min(5, Math.round(parseNumber(await get("AILOOP_EVAL_REWORK_MAX_ATTEMPTS"), 1)))
  );
  const consoleHost = (await get("AILOOP_CONSOLE_HOST")) ?? "0.0.0.0";
  const consolePort = parseNumber(await get("AILOOP_CONSOLE_PORT"), 3090);
  const consoleAdminToken = (await get("AILOOP_CONSOLE_ADMIN_TOKEN")) ?? "";
  const maxRetainRuns = parseNumber(await get("AILOOP_MAX_RETAIN_RUNS"), 50);

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
      usdPerRound: parseNumber(await get("AILOOP_BUDGET_USD_PER_ROUND"), 0.5),
      timeMinutes: parseNumber(await get("AILOOP_BUDGET_TIME_MINUTES"), 60),
      actions: parseNumber(await get("AILOOP_BUDGET_ACTIONS"), 30)
    },
    codex: {
      bin: (await get("AILOOP_CODEX_BIN")) ?? "codex",
      model: (await get("AILOOP_CODEX_MODEL")) ?? "",
      profile: (await get("AILOOP_CODEX_PROFILE")) ?? "",
      plannerSandbox: parseSandboxMode(await get("AILOOP_CODEX_PLANNER_SANDBOX"), "read-only"),
      executorSandbox: parseSandboxMode(await get("AILOOP_CODEX_EXECUTOR_SANDBOX"), "danger-full-access"),
      evaluatorSandbox: parseSandboxMode(await get("AILOOP_CODEX_EVALUATOR_SANDBOX"), "danger-full-access"),
      timeoutMs: parseNumber(await get("AILOOP_CODEX_TIMEOUT_MS"), 180_000),
      llmEvaluatorDimensions: parseLlmEvaluatorDimensions(await get("AILOOP_LLM_EVALUATOR_DIMENSIONS")),
      llmEvaluatorMinPassScore: Math.max(
        0,
        Math.min(100, parseNumber(await get("AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE"), 75))
      )
    }
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    hydrateEnvFromShell();
  }

  const get = (key: string): string | undefined => env[key];

  const homeDir = path.resolve(get("AILOOP_HOME") ?? "./.ailoop");
  const intervalSeconds = parseNumber(get("AILOOP_INTERVAL_SECONDS"), 1200);
  const maxCycles = parseNumber(get("AILOOP_MAX_CYCLES"), 0);
  const exitOnError = (get("AILOOP_EXIT_ON_ERROR") ?? "0") === "1";
  const evaluatorReworkMaxAttempts = Math.max(
    0,
    Math.min(5, Math.round(parseNumber(get("AILOOP_EVAL_REWORK_MAX_ATTEMPTS"), 1)))
  );
  const consoleHost = get("AILOOP_CONSOLE_HOST") ?? "0.0.0.0";
  const consolePort = parseNumber(get("AILOOP_CONSOLE_PORT"), 3090);
  const consoleAdminToken = get("AILOOP_CONSOLE_ADMIN_TOKEN") ?? "";
  const maxRetainRuns = parseNumber(get("AILOOP_MAX_RETAIN_RUNS"), 50);

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
      usdPerRound: parseNumber(get("AILOOP_BUDGET_USD_PER_ROUND"), 0.5),
      timeMinutes: parseNumber(get("AILOOP_BUDGET_TIME_MINUTES"), 60),
      actions: parseNumber(get("AILOOP_BUDGET_ACTIONS"), 30)
    },
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

export async function saveConfigToDb(config: AppConfig, db: DatabaseManager): Promise<void> {
  await db.setConfig("AILOOP_HOME", config.homeDir);
  await db.setConfig("AILOOP_INTERVAL_SECONDS", config.intervalSeconds.toString());
  await db.setConfig("AILOOP_MAX_CYCLES", config.maxCycles.toString());
  await db.setConfig("AILOOP_EXIT_ON_ERROR", config.exitOnError ? "1" : "0");
  await db.setConfig("AILOOP_EVAL_REWORK_MAX_ATTEMPTS", config.evaluatorReworkMaxAttempts.toString());
  await db.setConfig("AILOOP_CONSOLE_HOST", config.consoleHost);
  await db.setConfig("AILOOP_CONSOLE_PORT", config.consolePort.toString());
  await db.setConfig("AILOOP_CONSOLE_ADMIN_TOKEN", config.consoleAdminToken);
  await db.setConfig("AILOOP_MAX_RETAIN_RUNS", config.maxRetainRuns.toString());
  await db.setConfig("AILOOP_BUDGET_USD_PER_ROUND", config.budget.usdPerRound.toString());
  await db.setConfig("AILOOP_BUDGET_TIME_MINUTES", config.budget.timeMinutes.toString());
  await db.setConfig("AILOOP_BUDGET_ACTIONS", config.budget.actions.toString());
  await db.setConfig("AILOOP_CODEX_BIN", config.codex.bin);
  await db.setConfig("AILOOP_CODEX_MODEL", config.codex.model);
  await db.setConfig("AILOOP_CODEX_PROFILE", config.codex.profile);
  await db.setConfig("AILOOP_CODEX_PLANNER_SANDBOX", config.codex.plannerSandbox);
  await db.setConfig("AILOOP_CODEX_EXECUTOR_SANDBOX", config.codex.executorSandbox);
  await db.setConfig("AILOOP_CODEX_EVALUATOR_SANDBOX", config.codex.evaluatorSandbox);
  await db.setConfig("AILOOP_CODEX_TIMEOUT_MS", config.codex.timeoutMs.toString());
  await db.setConfig("AILOOP_LLM_EVALUATOR_DIMENSIONS", config.codex.llmEvaluatorDimensions.join(","));
  await db.setConfig("AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE", config.codex.llmEvaluatorMinPassScore.toString());
}

