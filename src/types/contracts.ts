export type LoopStateName = "idle" | "running" | "cooldown" | "paused" | "stopping" | "error";

export type EvaluationDimension =
  | "goal_alignment"
  | "causal_validity"
  | "constraint_compliance"
  | "risk_externality"
  | "reversibility_resilience"
  | "learning_yield";


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
  previous_tool_result: ToolResult | null;
  previous_evaluation_dimensions?: DimensionAssessment[];
  current_budget: {
    limits: BudgetLimits;
    usage: BudgetUsage;
  } | null;
}

export interface SubTask {
  rationale: string;
  assignee: "executor" | "designer";
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
  previous_round_error: string | null;
  consecutive_evaluator_failures: number;
}

export interface ToolCallResult {
  ok: boolean;
  output: string;
  data?: unknown;
  error?: string;
}

export type AgentRole = "planner" | "executor" | "evaluator" | "leader" | "designer";

export interface ToolContext {
  role: AgentRole;
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
  operational_evidence?: string[];
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
  dimensions?: DimensionAssessment[];
  aggregate_score?: number;
}

export interface DimensionAssessment {
  dimension: EvaluationDimension;
  decision: "pass" | "fail" | "unknown";
  score: number;
  confidence: number;
  justification: string;
  evidence: string[];
  blocking_issues: string[];
  recommended_next_action: string;
}

export interface LeaderContext {
  goal: string;
  lastError: string | null;
  previousEvaluationJustification: string | null;
  previousEvaluationDimensions?: DimensionAssessment[];
  stateChange: string | null;
}

export interface LeaderDecision {
  rationale: string;
  action: "resume" | "stop";
  instructions: string[];
}

export interface RoundArtifacts {
  logPath: string;
  summaryPath: string;
  metricsPath: string;
  stateChangePath: string;
  evaluationPath: string;
}

export interface RoundEvaluationContext {
  subTask: SubTask;
  toolResult: ToolResult;
  stateChange: string;
  logLines: string[];
  runTimestamp: string;
  budgetLimits: BudgetLimits;
  budgetUsage: BudgetUsage;
  onLog?: (message: string) => void | Promise<void>;
}
