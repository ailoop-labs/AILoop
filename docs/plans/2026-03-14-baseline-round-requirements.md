# Baseline Round Requirements

## Status

Approved baseline extracted from `README.md` and `ARCHITECTURE.md`.

## Source-Of-Truth Scope

This note is a working extraction for implementation planning. It does not override `README.md` or `ARCHITECTURE.md`.

The purpose of this slice is to make the MVP round contract explicit enough for follow-up implementation without guessing.

## Requirement Slice

Implement the MVP round flow so that each round is:

- outcome-oriented
- observable
- budget-bounded
- recoverable where the environment allows
- interruptible by a human operator

## In Scope For This Baseline

- one atomic round at a time
- control-plane commands for `start`, `pause`, `resume`, `stop`, `status`, and `instruct`
- a planning -> execution -> evaluation loop
- file-based persistence and round artifacts under `AILOOP_HOME`
- budget enforcement for cost, time, and action count
- pause, rollback, and crash-recovery safety behavior
- Web Console visibility for state, budgets, round history, artifacts, and live instructions

## Non-Goals For This Slice

- multi-tenant orchestration
- cloud billing or org-level quotas
- plugin marketplace concerns
- distributed workers or horizontal scaling
- big-bang refactors or speculative abstractions

## Acceptance Criteria

### 1. Round Atomicity And Lifecycle

- The engine advances one measurable round at a time.
- Each round follows a deterministic lifecycle: preflight, planning, execution, evaluation, persist/transition.
- The planner emits exactly one atomic `SubTask` per round.
- The executor reads target state before mutation, makes the smallest coherent change, verifies after meaningful mutations, and returns a machine-readable result.
- The evaluator judges the observed state change against the `SubTask.objective` and `expected_outcome`, not against superficial activity.

### 2. Human Control And Pause Semantics

- The operator can `start`, `pause`, `resume`, `stop`, request `status`, and `instruct` the loop.
- The control plane writes commands and instructions into engine-managed state and does not execute round logic directly.
- The system pauses instead of continuing when any of the following occurs:
  - cost budget exceeded
  - time budget exceeded
  - action budget exceeded
  - repeated evaluator failures reach threshold
  - crash recovery detects an interrupted round
  - rollback is required but cannot be completed automatically
  - an operator issues `pause`
  - another guardrail blocks autonomous action
- `paused` is a safe waiting state that preserves evidence and requires deliberate continuation.

### 3. Budget And Guardrail Enforcement

- Budgets are enforced per round for:
  - cost budget
  - time budget
  - action budget
- Guardrails check remaining budget before each tool action.
- If a budget dimension crosses its limit, execution stops immediately, records a `BudgetBreach`, attempts rollback when supported, and transitions the run to `paused`.
- Default MVP targets are:
  - `AILOOP_BUDGET_USD_PER_ROUND=0.5`
  - `AILOOP_BUDGET_TIME_MINUTES=15`
  - `AILOOP_BUDGET_ACTIONS=30`

### 4. Observability And Artifact Requirements

- Every round must leave behind reviewable artifacts that explain what happened.
- The Web Console must expose current state, budgets, recent rounds, artifacts, and live instructions.
- Operator-facing UX must preserve high-bandwidth pattern recognition rather than devolving into raw-text-only inspection.
- If core state logic, persistence shape, or governance flow changes, corresponding Web Console alignment is required.

Required persistence layout under `AILOOP_HOME`:

```text
.ailoop/
  state.json
  loop.lock
  goal.md
  instructions.queue.json
  runs/
    <timestamp>.round.log
    <timestamp>.round.summary.md
    <timestamp>.round.metrics.json
    <timestamp>.round.state_change.txt
    <timestamp>.round.evaluation.json
```

Required artifact semantics:

- `state.json`: canonical persisted engine state and counters
- `loop.lock`: concurrent-engine lock metadata
- `goal.md`: current high-level objective
- `instructions.queue.json`: queued human feedback for the next round boundary
- `*.round.log`: timestamped execution log
- `*.round.summary.md`: human-readable round summary
- `*.round.metrics.json`: budget use, duration, retries, and phase timings
- `*.round.state_change.txt`: unified diff or concise mutation log
- `*.round.evaluation.json`: evaluator decision and evidence

### 5. Recoverability And Crash Safety

- The engine creates a pre-round snapshot when the environment supports it.
- The workspace manager records round-level diffs or mutation summaries.
- If a round fails catastrophically or a budget breach requires rollback, the engine attempts rollback when policy and environment allow.
- On startup after a crash, the engine must detect interrupted rounds, mark them incomplete, attempt rollback when possible, and transition to `paused` for operator review.
- If rollback is unsupported or incomplete, the run must pause instead of proceeding on uncertain state.

### 6. Secret Safety

- Logs and persisted artifacts must automatically redact known secrets from environment variables containing `TOKEN`, `KEY`, or `SECRET`.
- Redaction must happen in artifact/log writers rather than relying on agent discipline alone.

### 7. Product-Definition Gate

- Product definition is a first-class prerequisite for safe execution.
- If the current requirement artifact is missing, stale, or complete for the current slice, the engine must invoke `ProductManager` before finalizing the round task.
- The `ProductManager` output for this gate is a human-readable Markdown requirement artifact.
- The `ProjectPlanner` uses the current requirement artifact summary as input and still emits exactly one execution `SubTask`.

## Minimum Verifiable Signals For Follow-Up Work

The next implementation round should be able to show all of the following without relying on inference:

- persisted run state exists and reflects explicit loop states
- round artifacts are written to the required locations
- budget checks happen before mutating tool actions
- pause transitions preserve evidence and require explicit resume
- crash recovery does not silently continue interrupted work
- any state-model change that affects operators is also surfaced in the Web Console
