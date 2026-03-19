import path from "node:path";
import type { BudgetLimits, EvaluationDimension } from "../types/contracts";
import { DatabaseManager } from "../utils/db";

export type AISandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// Backward compatibility
export type CodexSandboxMode = AISandboxMode;

export const DEFAULT_AILOOP_HOME_DIRNAME = ".ailoop";
export const CONFIG_DB_FILENAME = "ailoop.db";

export const DEFAULT_LLM_EVALUATOR_DIMENSIONS: EvaluationDimension[] = [
  "goal_alignment",
  "causal_validity",
  "constraint_compliance",
  "risk_externality",
  "reversibility_resilience",
  "learning_yield"
];
export const FIXED_AI_CLI_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_EVALUATION_DIMENSIONS = new Set<EvaluationDimension>(DEFAULT_LLM_EVALUATOR_DIMENSIONS);

export interface AIConfig {
  bin: string;
  model: string;
  profile: string;
  plannerSandbox: AISandboxMode;
  executorSandbox: AISandboxMode;
  evaluatorSandbox: AISandboxMode;
  timeoutMs: number;
  llmEvaluatorDimensions: EvaluationDimension[];
  llmEvaluatorMinPassScore: number;
}

// Backward compatibility
export type CodexConfig = AIConfig;

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
  ai: AIConfig;
  // Backward compatibility
  codex: AIConfig;
}

export interface LoadConfigOptions {
  homeDir?: string;
  workspaceRoot?: string;
  db?: DatabaseManager;
}

type ConfigRecord = Record<string, string | undefined>;

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

function defaultCliModelForBin(bin: string): string {
  const basename = path.basename(bin).toLowerCase();
  if (basename === "claude" || basename.includes("claude")) {
    return "claude-opus-4-6";
  }
  if (basename === "gemini" || basename.includes("gemini")) {
    return "";
  }
  if (basename === "opencode" || basename.includes("opencode")) {
    return "";
  }
  return "gpt-5.4";
}

function parseSandboxMode(value: string | undefined, fallback: AISandboxMode): AISandboxMode {
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

export function resolveAiloopHome(workspaceRoot = process.cwd()): string {
  return path.resolve(workspaceRoot, DEFAULT_AILOOP_HOME_DIRNAME);
}

export function resolveConfigDbPath(homeDir = resolveAiloopHome()): string {
  return path.join(homeDir, CONFIG_DB_FILENAME);
}

function isConfigRecordInput(value: unknown): value is ConfigRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length === 0 || keys.some((key) => key.startsWith("AILOOP_"));
}

function resolveHomeDirForConfigRecord(record: ConfigRecord): string {
  return path.resolve(record.AILOOP_HOME ?? resolveAiloopHome());
}

function resolveHomeDirFromOptions(options: LoadConfigOptions | undefined): string {
  if (options?.homeDir) {
    return path.resolve(options.homeDir);
  }

  return resolveAiloopHome(options?.workspaceRoot);
}

function buildConfig(values: ConfigRecord, homeDir: string): AppConfig {
  const intervalSeconds = parseNumber(values.AILOOP_INTERVAL_SECONDS, 1200);
  const maxCycles = parseNumber(values.AILOOP_MAX_CYCLES, 0);
  const exitOnError = (values.AILOOP_EXIT_ON_ERROR ?? "0") === "1";
  const evaluatorReworkMaxAttempts = Math.max(
    0,
    Math.min(5, Math.round(parseNumber(values.AILOOP_EVAL_REWORK_MAX_ATTEMPTS, 1)))
  );
  const consoleHost = values.AILOOP_CONSOLE_HOST ?? "0.0.0.0";
  const consolePort = parseNumber(values.AILOOP_CONSOLE_PORT, 3090);
  const consoleAdminToken = values.AILOOP_CONSOLE_ADMIN_TOKEN ?? "";
  const maxRetainRuns = parseNumber(values.AILOOP_MAX_RETAIN_RUNS, 50);

  const aiBin = values.AILOOP_AI_CLI_BIN ?? values.AILOOP_CODEX_BIN ?? "codex";
  const aiModel = values.AILOOP_AI_CLI_MODEL ?? values.AILOOP_CODEX_MODEL ?? defaultCliModelForBin(aiBin);
  const aiProfile = values.AILOOP_AI_CLI_PROFILE ?? values.AILOOP_CODEX_PROFILE ?? "";
  const plannerSandbox = parseSandboxMode(
    values.AILOOP_AI_CLI_PLANNER_SANDBOX ?? values.AILOOP_CODEX_PLANNER_SANDBOX,
    "read-only"
  );
  const executorSandbox = parseSandboxMode(
    values.AILOOP_AI_CLI_EXECUTOR_SANDBOX ?? values.AILOOP_CODEX_EXECUTOR_SANDBOX,
    "danger-full-access"
  );
  const evaluatorSandbox = parseSandboxMode(
    values.AILOOP_AI_CLI_EVALUATOR_SANDBOX ?? values.AILOOP_CODEX_EVALUATOR_SANDBOX,
    "danger-full-access"
  );
  const timeoutMs = FIXED_AI_CLI_TIMEOUT_MS;

  const aiConfig: AIConfig = {
    bin: aiBin,
    model: aiModel,
    profile: aiProfile,
    plannerSandbox,
    executorSandbox,
    evaluatorSandbox,
    timeoutMs,
    llmEvaluatorDimensions: parseLlmEvaluatorDimensions(values.AILOOP_LLM_EVALUATOR_DIMENSIONS),
    llmEvaluatorMinPassScore: Math.max(
      0,
      Math.min(100, parseNumber(values.AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE, 75))
    )
  };

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
      usdPerRound: parseNumber(values.AILOOP_BUDGET_USD_PER_ROUND, 0.5),
      timeMinutes: parseNumber(values.AILOOP_BUDGET_TIME_MINUTES, 60),
      actions: parseNumber(values.AILOOP_BUDGET_ACTIONS, 30)
    },
    ai: aiConfig,
    codex: aiConfig
  };
}

function readConfigRecordSync(homeDir: string, db?: DatabaseManager): ConfigRecord {
  const effectiveDb = db ?? new DatabaseManager({ dbPath: resolveConfigDbPath(homeDir) });

  try {
    return effectiveDb.getAllConfigSync();
  } finally {
    if (!db) {
      effectiveDb.close();
    }
  }
}

async function readConfigRecordAsync(homeDir: string, db?: DatabaseManager): Promise<ConfigRecord> {
  const effectiveDb = db ?? new DatabaseManager({ dbPath: resolveConfigDbPath(homeDir) });

  try {
    return await effectiveDb.getAllConfig();
  } finally {
    if (!db) {
      effectiveDb.close();
    }
  }
}

export async function loadConfigAsync(
  input?: ConfigRecord | LoadConfigOptions,
  db?: DatabaseManager
): Promise<AppConfig> {
  if (isConfigRecordInput(input)) {
    return buildConfig(input, resolveHomeDirForConfigRecord(input));
  }

  const options = input;
  const homeDir = resolveHomeDirFromOptions(options);
  const values = await readConfigRecordAsync(homeDir, options?.db ?? db);
  return buildConfig(values, homeDir);
}

export function loadConfig(input?: ConfigRecord | LoadConfigOptions): AppConfig {
  if (isConfigRecordInput(input)) {
    return buildConfig(input, resolveHomeDirForConfigRecord(input));
  }

  const homeDir = resolveHomeDirFromOptions(input);
  const values = readConfigRecordSync(homeDir, input?.db);
  return buildConfig(values, homeDir);
}

export async function saveConfigToDb(config: AppConfig, db: DatabaseManager): Promise<void> {
  await db.deleteConfig("AILOOP_HOME");
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

  await db.setConfig("AILOOP_AI_CLI_BIN", config.ai.bin);
  await db.setConfig("AILOOP_AI_CLI_MODEL", config.ai.model);
  await db.setConfig("AILOOP_AI_CLI_PROFILE", config.ai.profile);
  await db.setConfig("AILOOP_AI_CLI_PLANNER_SANDBOX", config.ai.plannerSandbox);
  await db.setConfig("AILOOP_AI_CLI_EXECUTOR_SANDBOX", config.ai.executorSandbox);
  await db.setConfig("AILOOP_AI_CLI_EVALUATOR_SANDBOX", config.ai.evaluatorSandbox);
  await db.deleteConfig("AILOOP_AI_CLI_TIMEOUT_MS");
  await db.deleteConfig("AILOOP_CODEX_BIN");
  await db.deleteConfig("AILOOP_CODEX_MODEL");
  await db.deleteConfig("AILOOP_CODEX_PROFILE");
  await db.deleteConfig("AILOOP_CODEX_PLANNER_SANDBOX");
  await db.deleteConfig("AILOOP_CODEX_EXECUTOR_SANDBOX");
  await db.deleteConfig("AILOOP_CODEX_EVALUATOR_SANDBOX");
  await db.deleteConfig("AILOOP_CODEX_TIMEOUT_MS");

  await db.setConfig("AILOOP_LLM_EVALUATOR_DIMENSIONS", config.ai.llmEvaluatorDimensions.join(","));
  await db.setConfig("AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE", config.ai.llmEvaluatorMinPassScore.toString());
}
