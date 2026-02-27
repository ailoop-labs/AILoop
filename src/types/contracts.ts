export type LoopStateName = "idle" | "running" | "paused" | "stopping" | "error";

export type EvaluatorType = "shell" | "llm" | "webhook";

export interface BudgetLimits {
  usdPerRound: number;
  timeMinutes: number;
  actions: number;
}

export interface BudgetUsage {
  usdUsed: number;
  actionsUsed: number;
  elapsedMs: number;
}

export interface LoopStateData {
  state: LoopStateName;
  round: number;
  updated_at: string;
  pid: number | null;
  last_error: string | null;
  consecutive_evaluator_failures: number;
  current_budget: {
    limits: BudgetLimits;
    usage: BudgetUsage;
  } | null;
}

export interface SubTask {
  rationale: string;
  objective: string;
  expected_outcome: string;
  recommended_tools: string[];
}

export interface PlannerContext {
  goal: string;
  instructions: string[];
  round: number;
  budget: BudgetLimits;
  previous_tool_result: ToolResult | null;
}

export interface ToolCallResult {
  ok: boolean;
  output: string;
  data?: unknown;
  error?: string;
}

export interface ToolContext {
  homeDir: string;
}

export interface Tool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolCallResult>;
  costEstimate: (args: Record<string, unknown>) => number;
}

export interface ActionRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  error?: string;
}

export interface ToolResult {
  status: "success" | "failure";
  summary: string;
  artifacts: {
    state_change_path: string;
    log_path: string;
  };
  error: {
    type: string;
    message: string;
  } | null;
  next_state_hint: "continue" | "pause" | "stop";
}

export interface EvaluationResult {
  decision: "pass" | "fail";
  justification: string;
  evidence: string[];
  recommended_next_action?: string;
}

export interface RoundArtifacts {
  logPath: string;
  summaryPath: string;
  metricsPath: string;
  stateChangePath: string;
}

export interface RoundEvaluationContext {
  subTask: SubTask;
  toolResult: ToolResult;
  stateChange: string;
  logLines: string[];
  runTimestamp: string;
}
