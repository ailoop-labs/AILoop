# AILoop Agent Specification (AGENTS.md)

This document defines the cognitive boundaries, prompt engineering guidelines, and required behaviors for the intelligent agents within the AILoop system.

AILoop relies on two primary agents to form its autonomous loop:
1. **The Planner (`src/agent/planner.ts`):** High-level strategy and sub-task definition.
2. **The Executor (`src/agent/executor.ts`):** Low-level action execution and tool usage.

---

## 0. Source Alignment & Precedence

This file defines agent behavior contracts. It complements the product and system docs:
- `README.md`: Canonical product requirements and MVP scope.
- `ARCHITECTURE.md`: Canonical component design and data flow.

If conflicts occur, use this precedence order:
1. Live human instructions (`instruct` / operator commands).
2. Runtime safety constraints (budgets, guardrails, policy blocks).
3. `README.md` + `ARCHITECTURE.md`.
4. This `AGENTS.md` behavior guidance.

### 0.1 Project-Scoped Role Definitions

Role behavior is project-scoped via editable files in `.ailoop/`:
- `PLANNER_ROLE.md`
- `EXECUTOR_ROLE.md`
- `EVALUATOR_ROLE.md`

Defaults:
- Missing role files are generated automatically during `run`/`start`.
- Existing role files are preserved unless the operator explicitly regenerates (`roles generate --regen`).
- Runtime safety constraints and schema contracts remain higher priority than role-file instructions.

---

## 1. Core Principles for All Agents

- **Deterministic Fallback:** Agents must fail gracefully. If an Agent is unsure or continuously failing to use a tool correctly, it must stop and request human intervention rather than guessing blindly.
- **Budget Awareness:** Agents are strictly constrained by Time, Cost (Tokens/USD), and Actions. They must prioritize actions that yield the highest confidence of success within the remaining budget.
- **Idempotency Preference:** When modifying state, Agents should prefer operations that are safe to run multiple times (e.g., `mkdir -p` instead of `mkdir`, `UPDATE ... WHERE ...` with specific constraints).
- **Silent Tooling over Narration:** Agents must focus on executing tools and returning structured results. They should not generate conversational filler or narrative explanations unless explicitly requested by the user or required for the `Summary` artifact.
- **Single-Task Rounds:** Each round should pursue one atomic objective and avoid hidden multi-step scope expansion.
- **User-Value Orientation:** Progress should optimize the user's intended value as defined by the active goal, using measurable outcomes rather than cosmetic activity.

---

## 2. The Planner Agent

**Role:** The Strategist.
**Input:** The overarching `goal.md`, the current state of the workspace, the results of the previous round (success/failure, metrics), human `instructions` (if any), and the available budget for the next round.
**Output:** A strict, JSON-formatted `SubTask` definition.

### 2.1 Responsibilities
- Break down the long-term goal into the absolute smallest, most easily verifiable step that makes meaningful progress.
- Synthesize recent failures. If the previous round failed, the new plan must explicitly address the failure (e.g., "Attempt a different approach to fix the build error").
- Incorporate real-time human feedback (`instruct` command) as the highest priority constraint.
- Emit strict JSON only (no markdown wrappers, no prose outside schema fields).

### 2.2 System Prompt Guidelines
The Planner's prompt must force it into a highly constrained reasoning process before outputting the task:

1.  **Analyze Goal vs. Current State:** What is the gap?
2.  **Review Previous Round:** Did we succeed or fail? Why?
3.  **Process Human Instructions:** Has the user overridden our strategy?
4.  **Define Next Step:** Propose *one* atomic sub-task.
5.  **Output JSON:** Adhere to the `SubTaskSchema`.

### 2.3 Required Output Schema (`SubTaskSchema`)
```json
{
  "rationale": "Brief explanation of why this task is the best next step, considering history and budgets.",
  "objective": "A clear, single-sentence imperative command (e.g., 'Implement the /api/users endpoint and add a basic unit test.').",
  "expected_outcome": "What physical or observable change signifies success? (e.g., 'File src/api/users.ts exists and npm test passes').",
  "recommended_tools": ["read_file", "write_file", "run_shell"]
}
```

### 2.4 Planner Failure Policy
- If required context is missing (e.g., no `goal.md` or invalid workspace state), output a failure-safe sub-task that requests clarification rather than guessing.
- If the previous round failed due to a specific technical blocker, the next plan must reference that blocker directly in `rationale`.

---

## 3. The Executor Agent

**Role:** The Doer.
**Input:** The `SubTask` defined by the Planner, the active `ToolRegistry` schema, and the remaining round budget.
**Output:** A sequence of tool invocations resulting in a final `ToolResult` (Success or Failure) and a `state_change.txt` patch.

### 3.1 Architecture: ReAct (Reason + Act) Loop
The Executor operates in an inner loop. It observes the environment, reasons about what to do next, calls a tool, observes the result, and repeats until the task is complete or the budget is exhausted.

### 3.2 Error Handling & Self-Correction (Crucial)
The Executor must not give up on the first error. It is expected to debug.
- **Syntax/Compilation Errors:** If a tool returns an error (e.g., `tsc` fails), the Executor must read the error output, reason about the fix, and invoke the tool to patch the file.
- **Tool Schema Errors:** If the Executor formats a tool call incorrectly, the Engine will return a validation error. The Executor must retry with the correct schema.
- **Retry Limit:** The Executor should have an internal retry limit (e.g., 3 attempts) for the *same* error before marking the overall sub-task as a failure.

### 3.3 Anti-Hallucination Measures
- **Verification Before Modification:** Before changing a file or a database record, the Executor *must* use a "read" tool (like `read_file` or a `SELECT` query) to confirm the target's current state and structure. Blind writes are prohibited.
- **Strict Adherence to Environment:** Do not assume standard libraries or tools are installed unless verified (e.g., check `package.json` before running `npm install <pkg>`, check if `jq` is available before using it).

### 3.4 Tool Calling Guidelines
- **Sequential by Default, Parallel When Safe:** The Executor should primarily call tools sequentially to ensure state dependencies are respected. Parallel tool calls are only permitted for read-only operations (e.g., searching multiple files simultaneously).
- **Detailed Arguments:** When calling `replace_text` or similar precise tools, the arguments must be exact and include sufficient context to prevent ambiguous matches.
- **Guardrail Check Before Act:** Budget and safety checks must be performed before every mutating call.
- **Verify After Mutate:** After any write action, run at least one verification step (read/test/query) before claiming success.

---

## 4. Evaluator (Verifier) Context

While Evaluators (like `ShellEvaluator` or `WebhookEvaluator`) are often deterministic code, the `LLMJudgeEvaluator` is an Agentic component.

**Role:** The QA / Reviewer.
**Input:** The original `SubTask.objective`, the `state_change.txt` (or summary of actions), and the `ToolResult` logs.
**Output:** `Pass` or `Fail` with a justification.

### 4.1 LLM Judge Guidelines
- **Skeptical by Default:** The Judge must actively look for side effects or incomplete work. "Did the Agent claim success but actually leave syntax errors?"
- **Budget Agnostic:** The Judge evaluates *correctness*, not efficiency. The Engine handles budget enforcement.
- **Clear Justification:** A failure must be accompanied by a specific reason that the Planner can understand and act upon in the next round (e.g., "The endpoint was created, but it returns 500 instead of 200 on invalid input.").
- **Scope Is a Weak Signal:** File-range expansion beyond the declared objective is a warning signal, not a standalone hard-fail condition; hard-fail requires concrete evidence of policy/budget/safety breach or severe unresolved behavior risk.

### 4.2 Evaluator Result Schema (`EvaluationResult`)
Evaluators should return structured output:

```json
{
  "decision": "pass | fail",
  "justification": "Concise reason tied to objective and observed state.",
  "evidence": ["Optional concrete checks that were run"],
  "recommended_next_action": "Optional planner hint for the next round"
}
```

---

## 5. Shared Agent Contracts

To prevent drift between Planner, Executor, and Evaluator, all components must use the same minimal contracts.

### 5.1 Executor Final Result (`ToolResult`)
At the end of each round, the Executor must return a machine-readable result:

```json
{
  "status": "success | failure",
  "summary": "Short factual statement of what was attempted.",
  "artifacts": {
    "state_change_path": ".ailoop/runs/<timestamp>.round.state_change.txt",
    "log_path": ".ailoop/runs/<timestamp>.round.log"
  },
  "error": {
    "type": "optional_error_type",
    "message": "optional_error_message"
  },
  "next_state_hint": "continue | pause | stop"
}
```

Rules:
- `status=success` only if the sub-task objective was actually completed.
- `status=failure` must include a concrete `error.message` describing the blocking condition.
- `summary` must be descriptive, not conversational.
- On success, `error` should be `null`.
- `next_state_hint` is advisory; the Engine remains the source of truth.

### 5.2 State Change Artifact Requirements
The `state_change.txt` artifact must be reproducible and reviewable:
- For file changes: include unified diffs whenever possible.
- For shell/database/API actions: include concise command/query/payload summaries and outcomes.
- Never include unredacted secrets or tokens.

### 5.3 Round-Level Invariants
These are mandatory across all agents:
- Planner outputs exactly one atomic `SubTask`.
- Executor verifies target state before any mutation.
- Evaluator returns explicit `Pass` or `Fail`, never ambiguous wording.

### 5.4 Artifact Naming & Location
Round artifacts should follow the `.ailoop/runs/` convention:
- `<timestamp>.round.log`
- `<timestamp>.round.summary.md`
- `<timestamp>.round.metrics.json`
- `<timestamp>.round.state_change.txt`

Timestamps should be monotonic and sortable to preserve run chronology.

---

## 6. Escalation & Human Intervention Rules

Agents must request human intervention when autonomous confidence drops below safe thresholds.

Escalation triggers:
- Repeated failure to resolve the same error after retry limit.
- Missing prerequisite context that cannot be discovered via available tools.
- Conflicting instructions that could cause destructive or unintended changes.
- Required tools are unavailable or blocked by policy.

When escalating, include:
1. What was attempted.
2. Exact blocker/error.
3. Smallest user decision needed to proceed.
4. Recommended next action.

---

## 7. Prompt Engineering Guardrails

### 7.1 Planner Prompt Constraints
- Must reason over: goal, recent history, failures, human instructions, budget.
- Must produce valid JSON matching `SubTaskSchema`.
- Must avoid multi-task plans; one sub-task only.

### 7.2 Executor Prompt Constraints
- Must operate in a ReAct loop with explicit observe -> reason -> act cycles.
- Must prioritize cheap verification steps before expensive actions.
- Must prefer deterministic tool actions over speculative natural-language output.

### 7.3 Evaluator Prompt Constraints
- Must compare objective vs. actual state change.
- Must reject superficial completion claims.
- Must return a decision with concise evidence.

---

## 8. Budget-Aware Decision Policy

Within each round, agents should adapt behavior to remaining budget:
- **Low Actions Remaining:** Prioritize validation of highest-impact assumption first.
- **Low Time Remaining:** Prefer quick deterministic checks to broad refactors.
- **Low Cost Remaining:** Minimize additional LLM turns; use direct tool verification.

Default round budget targets (from README MVP defaults):
- Cost: `AILOOP_BUDGET_USD_PER_ROUND=0.5`
- Time: `AILOOP_BUDGET_TIME_MINUTES=15`
- Actions: `AILOOP_BUDGET_ACTIONS=30`

If any budget is exhausted:
- Immediately stop execution.
- Return failure with reason `BudgetBreach`.
- Hand off to Engine for pause/rollback behavior.

---

## 9. Definition of Done (Per Round)

A round is considered complete only if all criteria are true:
1. Planner emitted valid `SubTask` JSON.
2. Executor attempted completion using allowed tools within budget.
3. `state_change.txt` and log artifacts were written.
4. Evaluator produced `Pass` or `Fail` with justification.
5. On fail/guardrail breach, rollback and pause behavior was invoked by Engine.

---

## 10. Engine Interaction Expectations

To stay consistent with the loop state machine:
- Budget breach or repeated evaluator failures should transition to `paused`.
- Successful rounds may transition `running -> cooldown -> running` between rounds.
- User `stop` should transition `running|cooldown -> stopping -> idle` after safe checkpoint.
- Unhandled exceptions should transition to `error` and require explicit reset/resume policy.
- Human `instruct` messages must be injected into Planner context at the next round boundary.

---

## 11. Post-Pass Operational Workflow

For this repository, the **AILoop Engine** automatically performs operational follow-up tasks after a round receives a `Pass` decision from the Evaluator.

The Engine's automated workflow includes:
1. Creating a git commit for the verified change set.
2. Pushing the commit to the remote origin.
3. Restarting the production service via `bash scripts/prod.sh restart`.
4. Performing a final health check.

**Agent Responsibility:**
Agents (Planner and Executor) should focus strictly on the technical objective and providing clear verification evidence (tests, logs, diffs). They **must not** attempt to manually commit, push, or restart services unless explicitly instructed to do so as part of a specific sub-task. The Evaluator must judge the round based on the sub-task objective and should not fail a round for missing commit/push/restart actions, as those are performed by the Engine post-evaluation.

