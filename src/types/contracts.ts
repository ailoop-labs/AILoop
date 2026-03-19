export type LoopStateName =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "cooldown"
  | "stopping"
  | "error";

export type CrashRecoveryInterruptionType = "startup_interrupted" | "round_interrupted";

export type CrashRecoveryRecoveredBy = "startup" | "status_check";

export interface CrashRecoveryStatus {
  interruption_type: CrashRecoveryInterruptionType;
  interrupted_state: LoopStateName;
  recovered_by: CrashRecoveryRecoveredBy;
  status_check_finalized: boolean;
  normal_round_execution_started: boolean;
  incomplete_work: boolean;
  reason: string;
  summary: string;
  next_action: string;
}

export type OperatorStatusReasonKind =
  | "manual_pause_requested"
  | "manual_pause"
  | "budget_breach"
  | "hot_file_governance"
  | "evaluator_strategic_block"
  | "evaluator_failure_limit"
  | "crash_recovery"
  | "rollback_incomplete"
  | "engine_error"
  | "guardrail_block";

export type OperatorStatusReasonSeverity = "info" | "warning" | "critical";

export interface OperatorStatusReason {
  kind: OperatorStatusReasonKind;
  title: string;
  summary: string;
  next_action: string;
  severity: OperatorStatusReasonSeverity;
}

export type ArtifactCompletenessKind = "none" | "log_only" | "partial_bundle" | "full_bundle";

export type RoundArtifactKind = "log" | "summary" | "metrics" | "state_change" | "evaluation";

export interface RoundArtifactPresence {
  kind: ArtifactCompletenessKind;
  label: string;
  present: RoundArtifactKind[];
  missing: RoundArtifactKind[];
}

export interface ArtifactCompletenessStatus {
  kind: ArtifactCompletenessKind;
  label: string;
  latest_round_timestamp: string | null;
  latest_artifact_at: string | null;
  present: RoundArtifactKind[];
  missing: RoundArtifactKind[];
}

export type BudgetDimension = "cost" | "time" | "actions";

export type BudgetHealth = "healthy" | "warning" | "breached";

export interface BudgetDimensionHealth {
  dimension: BudgetDimension;
  label: string;
  health: BudgetHealth;
  used: number;
  limit: number;
  ratio: number;
}

export interface BudgetHealthStatus {
  overall: BudgetHealth;
  breached_dimension: BudgetDimension | null;
  dimensions: BudgetDimensionHealth[];
}

export interface ActionRecord {
  tool: string;
  input?: any;
  args?: any; // Compatibility
  output: string;
  status?: "success" | "failure";
  ok?: boolean; // Compatibility
  duration_ms?: number;
  error?: string; // Compatibility
}

export interface SubTask {
  rationale: string;
  assignee: "executor" | "designer";
  objective: string;
  expected_outcome: string;
  impacted_files: string[];
  recommended_tools: string[];
}

export interface DimensionAssessment {
  dimension: string;
  decision: "pass" | "fail" | "warn" | "unknown";
  score: number;
  confidence: number;
  justification: string;
  evidence: string[];
  blocking_issues: string[];
  recommended_next_action: string;
}

export type HotFileGovernanceResultClass = "hot_file_growth_failure";

export type EvaluationRecoveryPath = "tactical_rework" | "strategic_governance";

export interface HotFileGovernanceResult {
  file_path: string;
  heuristic_labels: string[];
  result_class: HotFileGovernanceResultClass;
  reason: string;
  recommended_next_action: string;
}

export interface EvaluationResult {
  decision: "pass" | "fail";
  justification: string;
  root_cause?: string;
  evidence: string[];
  recommended_next_action?: string;
  recovery_path?: EvaluationRecoveryPath;
  dimensions?: DimensionAssessment[];
  aggregate_score?: number;
  hot_file_governance?: HotFileGovernanceResult | null;
}

export interface ToolResult {
  status: "success" | "failure";
  summary: string;
  error?: {
    type: string;
    message: string;
    stack?: string;
  };
  artifacts: {
    log_path: string;
    state_change_path: string;
    bundle_path?: string;
  };
  next_state_hint?: "continue" | "pause" | "stop";
  operational_evidence?: string[];
}

export interface PlannerContext {
  goal: string;
  instructions: string[];
  round: number;
  budget: BudgetLimits;
  previous_tool_result: ToolResult | null;
  previous_round_error: string | null;
  consecutive_evaluator_failures: number;
  requirement_artifact_status?: "missing" | "ready" | "needs_refresh";
  requirement_artifact_summary?: string | null;
}

export interface ContextSourceReference {
  path: string;
  reason: string;
}

export interface ContextSourceManifest {
  mandatory_sources: ContextSourceReference[];
  optional_sources: ContextSourceReference[];
  expansion_rule: string;
}

export interface ProductManagerContext {
  goal: string;
  instructions: string[];
  round: number;
  current_requirement_markdown: string | null;
  previous_tool_result: ToolResult | null;
  previous_round_error: string | null;
  runtime_policy_brief?: string[];
  source_manifest?: ContextSourceManifest | null;
}

export interface ExternalValidationTaskMetrics {
  stable_id: string;
  assignee: SubTask["assignee"];
  objective: string;
  expected_outcome: string;
  rounds: number;
  total_cost_usd: number;
  average_cost_usd_per_round: number;
  successful: boolean;
  latest_decision: EvaluationResult["decision"] | "unknown";
  human_interventions: number;
  no_op_claim_mismatches: number;
  evaluator_infrastructure_failures: number;
  hot_file_growth_lines: number;
  first_run_timestamp: string;
  latest_run_timestamp: string;
}

export interface ExternalValidationChecklistMetrics {
  rounds_per_successful_task: number | null;
  human_interventions_per_task: number | null;
  average_cost_usd_per_round: number | null;
  evaluator_infrastructure_failures: number;
  hot_file_growth_lines: number;
}

export interface ExternalValidationMetricsReport {
  task_count: number;
  successful_task_count: number;
  checklist: ExternalValidationChecklistMetrics;
  tasks: ExternalValidationTaskMetrics[];
}

export interface RequirementArtifactSnapshot {
  path: string;
  exists: boolean;
  artifact_status: "missing" | "ready" | "needs_refresh";
  lifecycle_status: "active" | "complete";
  title: string | null;
  summary: string | null;
  acceptance_criteria_total: number;
  acceptance_criteria_completed: number;
  markdown: string | null;
  updated_at: string | null;
}

export interface GoalReference {
  title: string;
  summary: string;
}

export interface LeaderContext {
  goal: string;
  lastError: string | null;
  previousEvaluationJustification: string | null;
  previousToolResult?: ToolResult | null;
  previousEvaluationDimensions?: DimensionAssessment[];
  previousHotFileGovernance?: HotFileGovernanceResult | null;
  stateChange: string | null;
}

export interface ExpertOpinion {
  expert_role: "senior_dev" | "qa_lead" | "product_owner";
  vote: "approve" | "reject";
  rationale: string;
  incapacity_flag: boolean;
  remediation_hints?: string[];
}

export interface CCBResult {
  decision: "approve" | "reject" | "escalate_to_human";
  experts: ExpertOpinion[];
  rationale: string;
}

export interface LeaderDecision {
  rationale: string;
  action: "resume" | "stop" | "escalate_to_ccb";
  diagnosis_type: "implementation_failure" | "constitutional_conflict";
  instructions: string[];
  proposed_readme_change?: string;
}

export interface LoopPaths {
  homeDir: string;
  runsDir: string;
  loopLogPath: string;
  taskPath: string;
  productRequirementsDirPath: string;
  activeRequirementPath: string;
  plannerRolePath: string;
  productManagerRolePath: string;
  executorRolePath: string;
  designerRolePath: string;
  evaluatorRolePath: string;
  leaderRolePath: string;
  instructionsPath: string;
  legacyInstructionsPath: string;
  statePath: string;
  legacyStatePath: string;
  pidPath: string;
  stopFlagPath: string;
  pauseFlagPath: string;
  lockPath: string;
  dbPath: string;
}

export interface LoopStateData {
  state: LoopStateName;
  round: number;
  updated_at: string;
  pid: number | null;
  goal_reference?: GoalReference | null;
  pause_reason: string | null;
  last_error: string | null;
  consecutive_evaluator_failures: number;
  previous_tool_result: ToolResult | null;
  previous_evaluation_dimensions?: DimensionAssessment[];
  previous_hot_file_governance?: HotFileGovernanceResult | null;
  current_budget: {
    limits: BudgetLimits;
    usage: BudgetUsage;
  } | null;
}

export interface BudgetLimits {
  usdPerRound: number;
  actions: number;
  timeMinutes: number;
}

export interface BudgetUsage {
  usdUsed: number;
  actionsUsed: number;
  elapsedMs: number;
}

export type AgentRole = "planner" | "product_manager" | "executor" | "evaluator" | "leader" | "designer" | "senior_dev" | "qa_lead" | "product_owner";

export type EvaluationDimension = string;

export interface ValidationArtifactManifest {
  round_log_path: string;
  state_change_path: string;
  bundle_path: string;
}

export interface ValidationStateChangeSummary {
  changed_files: string[];
  added_lines: number;
  removed_lines: number;
  notes: string[];
}

export interface ValidationSummary {
  status: "recorded" | "error_only" | "derived" | "missing";
  summary: string;
  primary_sources: string[];
  highlighted_signals: string[];
  full_detail_artifacts: string[];
}

export interface ValidationTargetedExcerpt {
  source: string;
  artifact_path: string;
  selection_reason: string;
  excerpt: string;
}

export interface ValidationRoundInconsistencyEvidence {
  file_path: string;
  artifact_path: string;
  excerpt: string;
}

export interface ValidationRoundInconsistencySummary {
  status: "none" | "present";
  summary: string;
  conflicting_signals: string[];
  direct_evidence: ValidationRoundInconsistencyEvidence[];
}

export interface ValidationExecutorSummary {
  status: ToolResult["status"];
  summary: string;
  next_state_hint: NonNullable<ToolResult["next_state_hint"]> | "continue";
  error: {
    type: string;
    message: string;
  } | null;
}

export interface ValidationHandoff {
  objective: string;
  expected_outcome: string;
  executor_summary: ValidationExecutorSummary;
  validation_summary: ValidationSummary;
  artifact_manifest: ValidationArtifactManifest;
  budget_limits: BudgetLimits;
  budget_usage: BudgetUsage;
  state_change_summary: ValidationStateChangeSummary;
  round_inconsistency_summary: ValidationRoundInconsistencySummary;
  targeted_excerpts: ValidationTargetedExcerpt[];
}

export interface RoundEvaluationContext {
  subTask: SubTask;
  toolResult: ToolResult;
  stateChange: string;
  logLines: string[];
  runTimestamp: string;
  budgetLimits: BudgetLimits;
  budgetUsage: BudgetUsage;
  validation_handoff: ValidationHandoff;
  onLog: (message: string) => void | Promise<void>;
}

export interface RoundArtifacts {
  logPath: string;
  summaryPath: string;
  metricsPath: string;
  stateChangePath: string;
  evaluationPath: string;
  bundlePath?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  role: AgentRole;
  round: number;
  goal: string;
  instructions: string[];
  paths: LoopPaths;
  guardrails: any;
  onLog: (message: string) => void | Promise<void>;
}

export type ToolCallResult = ToolResult;
