import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, CodexSandboxMode } from "./env";
import { DEFAULT_LLM_EVALUATOR_DIMENSIONS } from "./env";
import type { BudgetLimits, EvaluationDimension, EvaluatorType } from "../types/contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs";

const RUNTIME_CONFIG_FILENAME = "runtime-config.json";

export interface RuntimeLoopConfig {
  intervalSeconds: number;
  maxCycles: number;
  exitOnError: boolean;
  evaluatorReworkMaxAttempts: number;
  budget: BudgetLimits;
  evaluatorType: EvaluatorType;
  evaluatorCmd: string;
  webhookEvaluatorUrl: string;
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

function asEvaluatorType(value: unknown, fallback: EvaluatorType): EvaluatorType {
  if (value === "shell" || value === "llm" || value === "webhook") {
    return value;
  }
  return fallback;
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
    evaluatorType: config.evaluatorType,
    evaluatorCmd: config.evaluatorCmd,
    webhookEvaluatorUrl: config.webhookEvaluatorUrl,
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
    evaluatorType: asEvaluatorType(root.evaluatorType, fallback.evaluatorType),
    evaluatorCmd: asString(root.evaluatorCmd, fallback.evaluatorCmd),
    webhookEvaluatorUrl: asString(root.webhookEvaluatorUrl, fallback.webhookEvaluatorUrl),
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
  const raw = await readJsonFile<unknown>(filePath, defaults);
  return normalizeRuntimeLoopConfig(raw, defaults);
}

export async function saveRuntimeLoopConfig(baseConfig: AppConfig, next: unknown): Promise<RuntimeLoopConfig> {
  const defaults = extractRuntimeLoopConfig(baseConfig);
  const normalized = normalizeRuntimeLoopConfig(next, defaults);
  await writeJsonFile(runtimeConfigPath(baseConfig.homeDir), normalized);
  return normalized;
}

export async function patchRuntimeLoopConfig(baseConfig: AppConfig, patch: unknown): Promise<RuntimeLoopConfig> {
  const current = await readRuntimeLoopConfig(baseConfig);
  const merged = mergeRuntimePatch(current, patch);
  return saveRuntimeLoopConfig(baseConfig, merged);
}

export async function resetRuntimeLoopConfig(baseConfig: AppConfig): Promise<RuntimeLoopConfig> {
  const filePath = runtimeConfigPath(baseConfig.homeDir);
  await fs.rm(filePath, { force: true });
  return extractRuntimeLoopConfig(baseConfig);
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
    evaluatorType: runtime.evaluatorType,
    evaluatorCmd: runtime.evaluatorCmd,
    webhookEvaluatorUrl: runtime.webhookEvaluatorUrl,
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
    AILOOP_EVALUATOR_TYPE: runtime.evaluatorType,
    AILOOP_EVALUATOR_CMD: runtime.evaluatorCmd,
    AILOOP_WEBHOOK_EVALUATOR_URL: runtime.webhookEvaluatorUrl,
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
