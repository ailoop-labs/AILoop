import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, CodexSandboxMode } from "./env";
import { DEFAULT_LLM_EVALUATOR_DIMENSIONS } from "./env";
import type { BudgetLimits, EvaluationDimension } from "../types/contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs";
import { DatabaseManager } from "../utils/db";

const RUNTIME_CONFIG_FILENAME = "runtime-config.json";
const AI_DB_KEYS = {
  bin: "AILOOP_AI_CLI_BIN",
  model: "AILOOP_AI_CLI_MODEL",
  profile: "AILOOP_AI_CLI_PROFILE",
  plannerSandbox: "AILOOP_AI_CLI_PLANNER_SANDBOX",
  executorSandbox: "AILOOP_AI_CLI_EXECUTOR_SANDBOX",
  evaluatorSandbox: "AILOOP_AI_CLI_EVALUATOR_SANDBOX",
  timeoutMs: "AILOOP_AI_CLI_TIMEOUT_MS",
  llmEvaluatorDimensions: "AILOOP_LLM_EVALUATOR_DIMENSIONS",
  llmEvaluatorMinPassScore: "AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE"
} as const;
const LEGACY_AI_DB_KEYS = [
  "AILOOP_CODEX_BIN",
  "AILOOP_CODEX_MODEL",
  "AILOOP_CODEX_PROFILE",
  "AILOOP_CODEX_PLANNER_SANDBOX",
  "AILOOP_CODEX_EXECUTOR_SANDBOX",
  "AILOOP_CODEX_EVALUATOR_SANDBOX",
  "AILOOP_CODEX_TIMEOUT_MS"
] as const;

export interface RuntimeLoopConfig {
  intervalSeconds: number;
  maxCycles: number;
  exitOnError: boolean;
  evaluatorReworkMaxAttempts: number;
  budget: BudgetLimits;
  codex: {
    bin: string;
    model: string;
    profile: string;
    plannerSandbox: CodexSandboxMode;
    executorSandbox: CodexSandboxMode;
    evaluatorSandbox: CodexSandboxMode;
    timeoutMs: number;
    llmEvaluatorDimensions: EvaluationDimension[];
    llmEvaluatorMinPassScore: number;
  };
}

function runtimeConfigPath(homeDir: string): string {
  return path.join(homeDir, RUNTIME_CONFIG_FILENAME);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  let next = parsed;
  if (typeof min === "number") {
    next = Math.max(min, next);
  }
  if (typeof max === "number") {
    next = Math.min(max, next);
  }
  return next;
}

function asInteger(value: unknown, fallback: number, min?: number, max?: number): number {
  return Math.round(asNumber(value, fallback, min, max));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "1" || value.toLowerCase() === "true") {
      return true;
    }
    if (value === "0" || value.toLowerCase() === "false") {
      return false;
    }
  }
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function asSandbox(value: unknown, fallback: CodexSandboxMode): CodexSandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return fallback;
}

function asLlmEvaluatorDimensions(value: unknown, fallback: EvaluationDimension[]): EvaluationDimension[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const valid = new Set<EvaluationDimension>(DEFAULT_LLM_EVALUATOR_DIMENSIONS);
  const parsed = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is EvaluationDimension => valid.has(item as EvaluationDimension));

  if (parsed.length === 0) {
    return fallback;
  }

  return Array.from(new Set(parsed));
}

function parseDimensionsString(value: string | null, fallback: EvaluationDimension[]): EvaluationDimension[] {
  if (!value || !value.trim()) {
    return fallback;
  }

  const valid = new Set<EvaluationDimension>(DEFAULT_LLM_EVALUATOR_DIMENSIONS);
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is EvaluationDimension => valid.has(item as EvaluationDimension));

  if (parsed.length === 0) {
    return fallback;
  }

  return Array.from(new Set(parsed));
}

function serializeRuntimeLoopConfig(runtime: RuntimeLoopConfig): Omit<RuntimeLoopConfig, "codex"> {
  return {
    intervalSeconds: runtime.intervalSeconds,
    maxCycles: runtime.maxCycles,
    exitOnError: runtime.exitOnError,
    evaluatorReworkMaxAttempts: runtime.evaluatorReworkMaxAttempts,
    budget: {
      ...runtime.budget
    }
  };
}

async function readAiCliConfigFromDb(
  baseConfig: AppConfig,
  fallback: RuntimeLoopConfig["codex"]
): Promise<RuntimeLoopConfig["codex"]> {
  const db = new DatabaseManager({ dbPath: path.join(baseConfig.homeDir, "ailoop.db") });

  try {
    const [
      bin,
      model,
      profile,
      plannerSandbox,
      executorSandbox,
      evaluatorSandbox,
      timeoutMs,
      llmEvaluatorDimensions,
      llmEvaluatorMinPassScore
    ] = await Promise.all([
      db.getConfig(AI_DB_KEYS.bin),
      db.getConfig(AI_DB_KEYS.model),
      db.getConfig(AI_DB_KEYS.profile),
      db.getConfig(AI_DB_KEYS.plannerSandbox),
      db.getConfig(AI_DB_KEYS.executorSandbox),
      db.getConfig(AI_DB_KEYS.evaluatorSandbox),
      db.getConfig(AI_DB_KEYS.timeoutMs),
      db.getConfig(AI_DB_KEYS.llmEvaluatorDimensions),
      db.getConfig(AI_DB_KEYS.llmEvaluatorMinPassScore)
    ]);

    return {
      bin: asString(bin, fallback.bin),
      model: asString(model, fallback.model),
      profile: asString(profile, fallback.profile),
      plannerSandbox: asSandbox(plannerSandbox, fallback.plannerSandbox),
      executorSandbox: asSandbox(executorSandbox, fallback.executorSandbox),
      evaluatorSandbox: asSandbox(evaluatorSandbox, fallback.evaluatorSandbox),
      timeoutMs: asInteger(timeoutMs, fallback.timeoutMs, 10_000, 3_600_000),
      llmEvaluatorDimensions: parseDimensionsString(llmEvaluatorDimensions, fallback.llmEvaluatorDimensions),
      llmEvaluatorMinPassScore: asNumber(
        llmEvaluatorMinPassScore,
        fallback.llmEvaluatorMinPassScore,
        0,
        100
      )
    };
  } finally {
    db.close();
  }
}

async function writeAiCliConfigToDb(baseConfig: AppConfig, aiConfig: RuntimeLoopConfig["codex"]): Promise<void> {
  const db = new DatabaseManager({ dbPath: path.join(baseConfig.homeDir, "ailoop.db") });

  try {
    await db.setConfig(AI_DB_KEYS.bin, aiConfig.bin);
    await db.setConfig(AI_DB_KEYS.model, aiConfig.model);
    await db.setConfig(AI_DB_KEYS.profile, aiConfig.profile);
    await db.setConfig(AI_DB_KEYS.plannerSandbox, aiConfig.plannerSandbox);
    await db.setConfig(AI_DB_KEYS.executorSandbox, aiConfig.executorSandbox);
    await db.setConfig(AI_DB_KEYS.evaluatorSandbox, aiConfig.evaluatorSandbox);
    await db.setConfig(AI_DB_KEYS.timeoutMs, String(aiConfig.timeoutMs));
    await db.setConfig(AI_DB_KEYS.llmEvaluatorDimensions, aiConfig.llmEvaluatorDimensions.join(","));
    await db.setConfig(AI_DB_KEYS.llmEvaluatorMinPassScore, String(aiConfig.llmEvaluatorMinPassScore));

    for (const key of LEGACY_AI_DB_KEYS) {
      await db.deleteConfig(key);
    }
  } finally {
    db.close();
  }
}

async function clearAiCliConfigFromDb(baseConfig: AppConfig): Promise<void> {
  const db = new DatabaseManager({ dbPath: path.join(baseConfig.homeDir, "ailoop.db") });

  try {
    for (const key of [...Object.values(AI_DB_KEYS), ...LEGACY_AI_DB_KEYS]) {
      await db.deleteConfig(key);
    }
  } finally {
    db.close();
  }
}

export function extractRuntimeLoopConfig(config: AppConfig): RuntimeLoopConfig {
  return {
    intervalSeconds: config.intervalSeconds,
    maxCycles: config.maxCycles,
    exitOnError: config.exitOnError,
    evaluatorReworkMaxAttempts: config.evaluatorReworkMaxAttempts,
    budget: {
      usdPerRound: config.budget.usdPerRound,
      timeMinutes: config.budget.timeMinutes,
      actions: config.budget.actions
    },
    codex: {
      bin: config.codex.bin,
      model: config.codex.model,
      profile: config.codex.profile,
      plannerSandbox: config.codex.plannerSandbox,
      executorSandbox: config.codex.executorSandbox,
      evaluatorSandbox: config.codex.evaluatorSandbox,
      timeoutMs: config.codex.timeoutMs,
      llmEvaluatorDimensions: [...config.codex.llmEvaluatorDimensions],
      llmEvaluatorMinPassScore: config.codex.llmEvaluatorMinPassScore
    }
  };
}

function normalizeRuntimeLoopConfig(candidate: unknown, fallback: RuntimeLoopConfig): RuntimeLoopConfig {
  const root = asObject(candidate) ?? {};
  const budget = asObject(root.budget) ?? {};
  const codex = asObject(root.codex) ?? {};

  return {
    intervalSeconds: asInteger(root.intervalSeconds, fallback.intervalSeconds, 1, 86_400),
    maxCycles: asInteger(root.maxCycles, fallback.maxCycles, 0, 1_000_000),
    exitOnError: asBoolean(root.exitOnError, fallback.exitOnError),
    evaluatorReworkMaxAttempts: asInteger(
      root.evaluatorReworkMaxAttempts,
      fallback.evaluatorReworkMaxAttempts,
      0,
      5
    ),
    budget: {
      usdPerRound: asNumber(budget.usdPerRound, fallback.budget.usdPerRound, 0, 1_000_000),
      timeMinutes: asNumber(budget.timeMinutes, fallback.budget.timeMinutes, 1, 1_440),
      actions: asInteger(budget.actions, fallback.budget.actions, 1, 1_000_000)
    },
    codex: {
      bin: asString(codex.bin, fallback.codex.bin),
      model: asString(codex.model, fallback.codex.model),
      profile: asString(codex.profile, fallback.codex.profile),
      plannerSandbox: asSandbox(codex.plannerSandbox, fallback.codex.plannerSandbox),
      executorSandbox: asSandbox(codex.executorSandbox, fallback.codex.executorSandbox),
      evaluatorSandbox: asSandbox(codex.evaluatorSandbox, fallback.codex.evaluatorSandbox),
      timeoutMs: asInteger(codex.timeoutMs, fallback.codex.timeoutMs, 10_000, 3_600_000),
      llmEvaluatorDimensions: asLlmEvaluatorDimensions(codex.llmEvaluatorDimensions, fallback.codex.llmEvaluatorDimensions),
      llmEvaluatorMinPassScore: asNumber(codex.llmEvaluatorMinPassScore, fallback.codex.llmEvaluatorMinPassScore, 0, 100)
    }
  };
}

function mergeRuntimePatch(base: RuntimeLoopConfig, patch: unknown): RuntimeLoopConfig {
  const root = asObject(patch) ?? {};
  const budgetPatch = asObject(root.budget) ?? {};
  const codexPatch = asObject(root.codex) ?? {};

  return {
    ...base,
    ...root,
    budget: {
      ...base.budget,
      ...budgetPatch
    },
    codex: {
      ...base.codex,
      ...codexPatch
    }
  };
}

export async function readRuntimeLoopConfig(baseConfig: AppConfig): Promise<RuntimeLoopConfig> {
  const defaults = extractRuntimeLoopConfig(baseConfig);
  const filePath = runtimeConfigPath(baseConfig.homeDir);
  const raw = await readJsonFile<unknown>(filePath, serializeRuntimeLoopConfig(defaults));
  const normalized = normalizeRuntimeLoopConfig(raw, defaults);

  return {
    ...normalized,
    codex: await readAiCliConfigFromDb(baseConfig, normalized.codex)
  };
}

export async function saveRuntimeLoopConfig(baseConfig: AppConfig, next: unknown): Promise<RuntimeLoopConfig> {
  const defaults = extractRuntimeLoopConfig(baseConfig);
  const normalized = normalizeRuntimeLoopConfig(next, defaults);
  await writeJsonFile(runtimeConfigPath(baseConfig.homeDir), serializeRuntimeLoopConfig(normalized));
  await writeAiCliConfigToDb(baseConfig, normalized.codex);
  return readRuntimeLoopConfig(baseConfig);
}

export async function patchRuntimeLoopConfig(baseConfig: AppConfig, patch: unknown): Promise<RuntimeLoopConfig> {
  const current = await readRuntimeLoopConfig(baseConfig);
  const merged = mergeRuntimePatch(current, patch);
  return saveRuntimeLoopConfig(baseConfig, merged);
}

export async function resetRuntimeLoopConfig(baseConfig: AppConfig): Promise<RuntimeLoopConfig> {
  const filePath = runtimeConfigPath(baseConfig.homeDir);
  await fs.rm(filePath, { force: true });
  await clearAiCliConfigFromDb(baseConfig);
  return readRuntimeLoopConfig(baseConfig);
}

export function applyRuntimeLoopConfig(baseConfig: AppConfig, runtime: RuntimeLoopConfig): AppConfig {
  return {
    ...baseConfig,
    intervalSeconds: runtime.intervalSeconds,
    maxCycles: runtime.maxCycles,
    exitOnError: runtime.exitOnError,
    evaluatorReworkMaxAttempts: runtime.evaluatorReworkMaxAttempts,
    budget: {
      ...runtime.budget
    },
    ai: {
      ...(baseConfig.ai ?? baseConfig.codex),
      bin: runtime.codex.bin,
      model: runtime.codex.model,
      profile: runtime.codex.profile,
      plannerSandbox: runtime.codex.plannerSandbox,
      executorSandbox: runtime.codex.executorSandbox,
      evaluatorSandbox: runtime.codex.evaluatorSandbox,
      timeoutMs: runtime.codex.timeoutMs,
      llmEvaluatorDimensions: [...runtime.codex.llmEvaluatorDimensions],
      llmEvaluatorMinPassScore: runtime.codex.llmEvaluatorMinPassScore
    },
    codex: {
      ...baseConfig.codex,
      bin: runtime.codex.bin,
      model: runtime.codex.model,
      profile: runtime.codex.profile,
      plannerSandbox: runtime.codex.plannerSandbox,
      executorSandbox: runtime.codex.executorSandbox,
      evaluatorSandbox: runtime.codex.evaluatorSandbox,
      timeoutMs: runtime.codex.timeoutMs,
      llmEvaluatorDimensions: [...runtime.codex.llmEvaluatorDimensions],
      llmEvaluatorMinPassScore: runtime.codex.llmEvaluatorMinPassScore
    }
  };
}

export function runtimeLoopConfigToEnv(runtime: RuntimeLoopConfig): Record<string, string> {
  return {
    AILOOP_INTERVAL_SECONDS: String(runtime.intervalSeconds),
    AILOOP_MAX_CYCLES: String(runtime.maxCycles),
    AILOOP_EXIT_ON_ERROR: runtime.exitOnError ? "1" : "0",
    AILOOP_EVAL_REWORK_MAX_ATTEMPTS: String(runtime.evaluatorReworkMaxAttempts),
    AILOOP_BUDGET_USD_PER_ROUND: String(runtime.budget.usdPerRound),
    AILOOP_BUDGET_TIME_MINUTES: String(runtime.budget.timeMinutes),
    AILOOP_BUDGET_ACTIONS: String(runtime.budget.actions),
    AILOOP_AI_CLI_BIN: runtime.codex.bin,
    AILOOP_AI_CLI_MODEL: runtime.codex.model,
    AILOOP_AI_CLI_PROFILE: runtime.codex.profile,
    AILOOP_AI_CLI_PLANNER_SANDBOX: runtime.codex.plannerSandbox,
    AILOOP_AI_CLI_EXECUTOR_SANDBOX: runtime.codex.executorSandbox,
    AILOOP_AI_CLI_EVALUATOR_SANDBOX: runtime.codex.evaluatorSandbox,
    AILOOP_AI_CLI_TIMEOUT_MS: String(runtime.codex.timeoutMs),
    AILOOP_CODEX_BIN: runtime.codex.bin,
    AILOOP_CODEX_MODEL: runtime.codex.model,
    AILOOP_CODEX_PROFILE: runtime.codex.profile,
    AILOOP_CODEX_PLANNER_SANDBOX: runtime.codex.plannerSandbox,
    AILOOP_CODEX_EXECUTOR_SANDBOX: runtime.codex.executorSandbox,
    AILOOP_CODEX_EVALUATOR_SANDBOX: runtime.codex.evaluatorSandbox,
    AILOOP_CODEX_TIMEOUT_MS: String(runtime.codex.timeoutMs),
    AILOOP_LLM_EVALUATOR_DIMENSIONS: runtime.codex.llmEvaluatorDimensions.join(","),
    AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE: String(runtime.codex.llmEvaluatorMinPassScore)
  };
}
