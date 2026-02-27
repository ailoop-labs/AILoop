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
}
