export interface SubTask {
  rationale: string;
  objective: string;
  expected_outcome: string;
  recommended_tools: string[];
}

export type ToolResultStatus = "success" | "failure";
export type ToolResultNextStateHint = "continue" | "pause" | "stop";

export interface ToolResult {
  status: ToolResultStatus;
  summary: string;
  operational_evidence: string[];
  artifacts: {
    state_change_path: string;
    log_path: string;
  };
  error:
    | {
        type: string;
        message: string;
      }
    | null;
  next_state_hint: ToolResultNextStateHint;
}

export interface EvaluationResult {
  decision: "pass" | "fail";
  justification: string;
  evidence: string[];
  recommended_next_action?: string;
  dimensions?: DimensionAssessment[];
  aggregate_score?: number;
}

export type EvaluationDimension =
  | "goal_alignment"
  | "causal_validity"
  | "constraint_compliance"
  | "risk_externality"
  | "reversibility_resilience"
  | "learning_yield";

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
