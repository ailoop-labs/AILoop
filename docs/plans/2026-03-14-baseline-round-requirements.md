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
- The persisted run state uses the canonical architecture states: `idle`, `starting`, `running`, `cooldown`, `paused`, `stopping`, and `error`.
- Successful rounds transition `running -> cooldown`; recoverable safety interruptions transition to `paused`; safe shutdown transitions toward `stopping` and then `idle`.
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
- The executor result must remain machine-readable and include artifact references for the state-change record and execution log.
- Artifact references in summaries, evaluator evidence, and executor results must point to files that actually exist for that round.
- The recorded state-change artifact must account for every intentional workspace mutation made during the round, whether as a diff or a concise mutation log.

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

Required artifact consistency checks:

- if a round advertises `*.round.state_change.txt`, that file must exist at the recorded path
- if a summary or executor result lists an artifact path, the path must resolve to a round artifact written in that execution
- if the round creates an additional requirement or planning note intentionally, the state-change artifact must mention it explicitly rather than leaving the mutation implicit

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
- artifact references in round outputs resolve to real files, and the state-change log matches the actual mutations
- budget checks happen before mutating tool actions
- pause transitions preserve evidence and require explicit resume
- crash recovery does not silently continue interrupted work
- any state-model change that affects operators is also surfaced in the Web Console

## Source Traceability

This section maps each requirement area in this note back to the governing documentation so the next round can verify additions against source text instead of inference.

| Note section | Source lines |
| --- | --- |
| Requirement Slice | `README.md:8-23`; `ARCHITECTURE.md:5-23` |
| In Scope For This Baseline | `README.md:46-53`; `ARCHITECTURE.md:27-35` |
| Non-Goals For This Slice | `README.md:55-58`; `ARCHITECTURE.md:37-42` |
| Round Atomicity And Lifecycle | `ARCHITECTURE.md:19-23`; `ARCHITECTURE.md:149-158`; `ARCHITECTURE.md:162-210`; `ARCHITECTURE.md:218-345` |
| Human Control And Pause Semantics | `README.md:21`; `README.md:37-42`; `ARCHITECTURE.md:52-56`; `ARCHITECTURE.md:169-210`; `ARCHITECTURE.md:463-468` |
| Budget And Guardrail Enforcement | `README.md:20`; `README.md:37-38`; `README.md:51`; `ARCHITECTURE.md:256-262`; `ARCHITECTURE.md:383-407` |
| Observability And Artifact Requirements | `README.md:22`; `README.md:41`; `README.md:52-53`; `ARCHITECTURE.md:22`; `ARCHITECTURE.md:53`; `ARCHITECTURE.md:116-127`; `ARCHITECTURE.md:409-443` |
| Recoverability And Crash Safety | `README.md:38`; `README.md:42`; `ARCHITECTURE.md:103-114`; `ARCHITECTURE.md:447-457` |
| Secret Safety | `README.md:39`; `ARCHITECTURE.md:344-345`; `ARCHITECTURE.md:441-443` |
| Product-Definition Gate | `ARCHITECTURE.md:67`; `ARCHITECTURE.md:76-77`; `ARCHITECTURE.md:154-155`; `ARCHITECTURE.md:228-250`; `ARCHITECTURE.md:309-320` |
