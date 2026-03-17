# AILoop Engine Workflow (AILOOP_ENGINE_WORKFLOW.md)

AILoop is an automated system that achieves goals through continuous planning, execution, evaluation, and governance. This architecture is based on the collaboration of multiple specialized Agents, forming a controllable and observable Loop.

This document defines the cognitive boundaries, role definitions, and required behaviors of the intelligent agents *inside* the AILoop engine. 

*(Note: If you are an AI coding assistant helping to build this project, please refer to `AGENTS.md` for your own development workflow rules.)*

## 0. Source Alignment & Precedence

This document complements the product and system documentation (`README.md` and `ARCHITECTURE.md`). In case of conflicts, use the following priority order:
1. Live human instructions (`instruct` / operator commands).
2. Runtime safety constraints (budgets, guardrails, policy blocks).
3. `README.md` + `ARCHITECTURE.md`.
4. The behavior guidelines and workflows defined in this document (`AILOOP_ENGINE_WORKFLOW.md`).

## 1. System Role Definitions (Agent Roles)

The system consists of several highly specialized core Agents. Each Agent operates within a specific sandbox environment and permission level. They can be customized at the project level via role definition files (e.g., `PLANNER_ROLE.md`) in the `.ailoop/` directory:

* **ProjectPlannerAgent (The Strategist / Workflow Owner)**
  * **Responsibility**: Acts as the round-level project planning role. Based on the overarching goal (`Goal`), current requirement artifacts, and the history (including failure reasons or human instructions), it determines the next smallest meaningful unit of work for the current round and formulates one atomic sub-task (`SubTask`).
  * **Permissions**: Read-only. It does not modify any code; it only observes and decides.
  * **Output**: A JSON-formatted task execution plan containing detailed `rationale`, `objective`, and `expected_outcome`.

* **ProductManagerAgent (The Product Definer)** *(Used when product definition is missing or exhausted)*
  * **Responsibility**: Produces and updates human-readable product requirement documents. It defines user value, scope, non-goals, acceptance criteria, and design expectations for the current requirement slice.
  * **Permissions**: Read-only by default, or workspace-write only for creating approved Markdown requirement artifacts.
  * **Output**: A Markdown requirement document used by the `ProjectPlannerAgent` as upstream planning input.

* **ExecutorAgent (The Doer)**
  * **Responsibility**: Receives the sub-task from the ProjectPlanner and uses tools (e.g., writing files, executing shell commands) in a ReAct (Reason + Act) loop to accomplish the task. It must verify the target state before execution and perform tests/validation afterward.
  * **Permissions**: Danger-full-access (Highest execution permission).
  * **Characteristics**: Subject to strict limits on the number of actions, time, and budget. Must proactively attempt to fix errors when they occur.

* **Evaluator (The Judge)**
  * **Responsibility**: Independently reviews the results of the Executor. Compares the expected outcome with the actual State Change to determine a Pass or Fail, providing clear justification.
  * **Permissions**: High permission or Read-only (depending on the evaluation strategy configuration).
  * **Characteristics**: Maintains a skeptical attitude towards results. It focuses not only on whether the functionality is implemented but also vetoes over-engineered code that violates the "Ruthless Simplicity" principle. It should receive compact evidence briefs and artifact navigation hints by default rather than full raw log dumps.

* **LeaderAgent (The Governance Intervener)**
  * **Responsibility**: Takes over and analyzes the root cause when the loop encounters an anomaly or pauses due to automatic rework failures.
  * **Permissions**: Workspace-write.
  * **Function**: Analyzes whether the failure is an implementation issue or a conflict with the "Constitution" (`README.md`). Queries telemetry data to check the Friction Index and, if necessary, issues strategic instructions to the Executor, or requests the CCB to intervene for architectural migration or scope reduction.

* **DesignerAgent (The Designer)** *(Used in specific phases)*
  * **Responsibility**: Focuses on UI/UX, responsive layouts, and visual harmony. Emphasizes "High-Bandwidth UX," preferring visual timelines, color-coded status lights, semantic diffs, and interaction designs that allow humans to quickly recognize patterns.

* **SeniorDevAgent / CCB (Senior Developer Expert)** *(Used in governance phases)*
  * **Responsibility**: Acts as the technical expert on the Change Control Board (CCB). Ensures technical integrity, rejects "Big Bang Rewrites," and enforces incremental refactoring strategies (Strangler Fig Pattern).

* **QALeadAgent / CCB (QA Lead Expert)** *(Used in governance phases)*
  * **Responsibility**: Acts as the quality expert on the CCB. Protects test coverage and regression testing, rejecting unverified compromises.

* **ProductOwnerAgent / CCB (Product Owner Expert)** *(Used in governance phases)*
  * **Responsibility**: Acts as the business value expert on the CCB. Protects the core product value and rejects any architectural or UI changes that reduce the system's observability to humans (violating the High-Bandwidth UX mandate).

Note on terminology:

- `ProductManagerAgent` is a runtime product-definition role used to write and refresh requirement artifacts.
- `ProductOwnerAgent` remains a governance-phase CCB expert and is not the same role.

## 2. Core Principles for All Agents

* **Deterministic Fallback**: When encountering unsolvable tool errors or missing context, agents must gracefully stop and request human intervention. Blind guessing is strictly prohibited.
* **Budget Awareness**: Agents are constrained by time, cost, and action limits. They must prioritize actions that yield the highest confidence of success within the remaining budget.
* **Idempotency Preference**: When modifying state, prioritize operations that are safe to run multiple times.
* **Silent Tooling over Narration**: Focus on executing tools and returning structured results. Do not generate unnecessary explanatory text unless requested.
* **Single-Task Rounds**: Each Round should pursue only one atomic goal. Avoid hidden, multi-step scope expansions.
* **Anti-Hallucination Measures**: Before modifying files or databases, the Executor *must* use a "read" tool to confirm the current state of the target. Blind writing is strictly prohibited.
* **Compact Handoffs**: When one role hands off to another, prefer a concise summary, artifact manifest, and targeted evidence excerpts. Do not force downstream roles to ingest entire logs or massive raw diffs unless a narrow excerpt is strictly necessary.
* **Runtime Instruction Isolation**: Internal AILoop agents must not inherit repository-local `AGENTS.md` files, external skill catalogs, or collaborative workflows intended for AI coding assistants helping humans modify the AILoop repository.
* **Tiered Source Reading**: Runtime roles should read a fixed canonical source set first, then expand only when they can name the missing information and the exact source likely to resolve it.

## 3. Core Workflow and Sequence (The Loop Sequence)

The transition of each "Round" strictly follows this lifecycle, orchestrated by the `LoopEngine`:

### Phase 1: Pre-flight & Budget
1. The engine checks for current Pause or Stop flags. If a forced human abort is detected, it enters the suspension process.
2. Calculates the remaining time budget, money budget, and action count. If exhausted, throws a `BudgetBreach` and aborts the current round.

### Phase 2: Plan
1. The engine collects the current workspace Snapshot (file tree state) and accumulated changes (Diff).
2. Invokes the **ProjectPlannerAgent**.
3. The ProjectPlanner analyzes the goal, history, intervention instructions, and current requirement artifacts.
4. If product requirements are missing, stale, or exhausted, the ProjectPlanner wakes the **ProductManagerAgent** to produce or refresh the requirement Markdown for the next requirement slice.
5. The ProjectPlanner then outputs a clear, JSON-formatted `SubTask` for the current round.

Planning/runtime isolation rule:
- internal agent Codex sessions should run from an isolated scratch context rather than the repository root when possible
- if they need to inspect repository files, the prompt should provide the repo root explicitly and require absolute paths or an explicit `cd`
- repository-local coding-assistant skills must not be treated as runtime product-planning or evaluation instructions
- `AGENTS.md` should still influence runtime behavior, but only through an engine-supplied runtime-safe policy brief that preserves project principles such as DoD, Ruthless Simplicity, secret redaction, and high-bandwidth UX
- the ProductManager should receive a source manifest whose mandatory sources include `README.md`, `ARCHITECTURE.md`, `AILOOP_ENGINE_WORKFLOW.md`, and `AGENTS.md` (project principles only)
- optional docs/plans should be navigational candidates, not automatically scanned by default

### Phase 3: Execute
1. The engine passes the `SubTask` to the **ExecutorAgent**.
2. The Executor follows the plan, using an "Observe -> Reason -> Act" loop to modify the codebase using tools.
3. If encountering compilation errors or tool schema errors, the Executor will retry internally (up to a threshold).
4. During execution, all actions and outputs are recorded in an independent Round Log file.
5. Upon completion, the Executor generates a summary of the execution (`ToolResult`).

### Phase 4: Artifacts & Evaluate
1. The engine collects the Executor's post-execution state and generates a difference file (`State Change Artifact`).
2. The engine prepares a compact evaluation brief that includes the round objective, expected outcome, executor summary, validation summary, artifact paths, and only the smallest targeted excerpts needed for judgment.
3. Invokes the **Evaluator** to analyze this data.
4. **Pass**: If the comprehensive score meets or exceeds the configured passing threshold, the Round is deemed successful. The engine cleans up temporary states, saves summary results, and prepares for the next round.
5. **Fail**: If the score is too low or judged as Over-engineering, it returns the failure justification and enters the **Auto-Rework** mechanism.

Evaluation handoff rules:
- engine-managed observability artifacts such as `.ailoop/runs/*.round.log` must remain reviewable on disk, but should not be recursively embedded wholesale into the evaluator prompt
- `State Change Artifact` should emphasize intentional workspace mutations and concise evidence notes
- if the Evaluator itself cannot complete because its Codex call fails, the engine must record that as evaluator infrastructure failure instead of pretending the round merely lacked ordinary evidence
- evaluator runtime sessions must not inherit development-assistant instructions from the repository root

ProductManager handoff rules:
- start from the mandatory source manifest before exploring optional material
- treat `AGENTS.md` as a source of project-level runtime principles, not as a direct external-assistant workflow to obey literally
- if required context is still missing after the mandatory read set, declare the missing gap and inspect only the one or two listed optional sources most likely to resolve it
- if the gap remains unresolved, write concise `Open Questions` instead of guessing or broadly scanning the repository

### Phase 5: Rework & Break
1. If judged as a failure, the engine feeds the Failure Justification back to the Executor.
2. The Executor initiates a retry within the same round, attempting to fix the code it just broke.
3. If the number of retries exceeds the threshold (e.g., 2 or 3 consecutive failures), the system breaks, the state is set to `paused`, and a fatal failure is recorded.

Rework handoff rule:
- evaluator-to-executor rework instructions should be navigational and issue-focused
- pass blocking dimensions, recommended next action, and artifact references
- avoid replaying entire raw state-change files into the rework prompt unless the minimal relevant excerpt is known

### Phase 6: Leader / CCB Intervention
1. When the loop is set to `paused` (whether due to human intervention or severe failure), if governance intervention (`AILOOP_ENABLE_LEADER`) is enabled, the engine awakens the **LeaderAgent** (and potentially introduces CCB experts like SeniorDev, QALead, ProductOwner for consultation).
2. The Leader reads the failure logs through a secure sandbox, analyzes the Friction Index, and decides whether to guide the Executor, reduce scope, or issue a Clarification Request to the human. It waits for new intervention instructions from the human before continuing.

## 4. External Intervention & State Alignment

If a human operator manually modifies the codebase or infrastructure outside the autonomous loop to fix a bug or advance a goal:
1. **Mandatory Notification**: The operator MUST provide a brief summary of the changes to `instructions.queue.json`.
2. **Agent Behavior**: The ProjectPlanner and Leader MUST prioritize these intervention instructions to align their "memory" (internal state history) with the current codebase "reality." If the manual change materially alters product scope or acceptance criteria, the ProjectPlanner should refresh the requirement artifact through the ProductManager before resuming normal implementation rounds.
3. **Verification**: Before proceeding to the next architectural goal, the Agent should first verify the manual fix (e.g., by running tests).
4. **Escalation Triggers**: Agents will proactively request human assistance when: they continuously fail to resolve the same error, lack necessary context, face destructive instruction conflicts, or lack required tools.

## 5. Design Philosophy
This workflow implements the principle of **Separation of Product Definition, Delivery Planning, and Execution**. The ProductManager defines requirements, the ProjectPlanner decides the next round-level task, the Executor does not evaluate its own results, and the Evaluator acts as an independent third party for quality control, ensuring high Causal Validity for every code change. When the machine cannot close the loop, it requests human intervention through the Leader and CCB mechanisms, ensuring the system never enters an out-of-control infinite loop.
