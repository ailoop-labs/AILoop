# Requirement Slice: Observable Safe Round Baseline

## Problem / User Value
AILoop is only useful if an operator can trust that one round makes bounded progress and leaves behind reviewable evidence. Before richer autonomy, governance escalation, or deeper UI work matters, the product needs a clear end-to-end baseline where a human can start a run, see its current state, and inspect what happened without relying on opaque internal behavior.

This slice matters now because it establishes the first trustworthy control loop. It gives the ProjectPlanner a stable requirement target, and it gives the Evaluator concrete signals for judging whether the engine is making safe, observable progress.

## Context
- `README.md` and `ARCHITECTURE.md` require one measurable round at a time, explicit budgets, transparent history, and pause as the default safety response.
- The Web Console is a first-class operator surface, so operator-facing state cannot exist only in internal files or CLI-only output.
- There is no active requirement artifact for the current slice, so the first slice should be foundational, narrow, and directly reviewable by a human.
- This slice depends on the existing architectural contracts for `ProjectPlanner`, `Executor`, `Evaluator`, canonical run state, and engine-managed artifacts under `AILOOP_HOME`.

## In Scope
- One active run for one workspace and one goal.
- One round that proceeds through planning, execution, evaluation, and persistence.
- Canonical persisted run state for the round lifecycle.
- Round-level budget visibility and enforcement for cost, time, and action count.
- Engine-managed round artifacts that let a human inspect what happened after the round.
- Operator-visible status parity between CLI/API and Web Console for the current run state, latest round result, and budget health.
- Explicit safe pause behavior when a guardrail blocks continued autonomous work.

## Out Of Scope
- Multi-tenant auth, billing, or plugin marketplace behavior.
- Leader or CCB intervention flows beyond preserving compatible pause points for later governance.
- Advanced rollback coverage for every environment type.
- Rich analytics, historical dashboards, or polished visualization work beyond clear MVP visibility.
- Expanding the executor contract beyond the documented observe -> reason -> act model.
- Detailed implementation plans, task breakdowns, or SubTask JSON in this artifact.

## Acceptance Criteria
- Starting a run produces a valid persisted state transition for one round. Successful rounds end in `cooldown`; rounds blocked by safety or guardrails end in `paused` with an explicit reason.
- After the round, `.ailoop/runs/` contains a matching timestamped artifact set including `.round.log`, `.round.summary.md`, `.round.metrics.json`, `.round.state_change.txt`, and `.round.evaluation.json`.
- The summary artifact states goal alignment, actions taken, evaluation result, consumed budget versus limits, risks or assumptions, and a next-round recommendation.
- The metrics artifact includes numeric cost, duration, and action-count fields for the round.
- The state-change artifact contains enough reproducible evidence for a human to understand what changed.
- Persisted logs and artifacts do not contain unredacted secrets from environment variables whose names contain `TOKEN`, `KEY`, or `SECRET`.
- CLI/API status and Web Console status expose the same canonical run state, active goal, latest round result, and budget consumption or remaining values.
- If cost, time, or action budget is exhausted before or during round work, autonomous execution does not continue silently; the run pauses and the pause reason is persisted and surfaced to the operator.
- Failure is explicit. If the round does not satisfy evaluation or is blocked by a guardrail, the operator can inspect artifacts and status surfaces to understand why the system did not continue.

## UX / Observability Notes
- Primary operator signals for this slice are current state, latest round outcome, budget health, and direct access to the latest artifacts.
- The Web Console should present these signals in a scannable form that supports pattern recognition rather than forcing the operator to parse raw logs as the primary interface.
- Raw logs remain available, but they are secondary to high-signal status, budget, and outcome summaries.
- CLI/API and Web Console should use the same state names and budget terminology so the operator does not have to translate between surfaces.
- Operator trust depends on artifact-first visibility. It should always be obvious whether the system progressed, paused safely, or needs human review.

## Constraints
- Follow Documentation-Driven Development. If the codebase conflicts with `README.md` or `ARCHITECTURE.md`, this requirement aligns to the documentation.
- Keep the solution ruthlessly simple. This slice should establish the minimum trustworthy end-to-end loop, not a generalized orchestration platform.
- Pause is the default safety response when budgets, guardrails, or recoverability limits prevent safe continuation.
- The engine owns canonical run artifacts. Operator surfaces may reference or summarize them, but must not create competing histories.
- Recoverability must not be faked. If rollback is unsupported in the active environment, the system should preserve evidence and pause for review instead of implying safe recovery.
- Secret redaction is mandatory for persisted logs and artifacts.

## Open Questions
- None for this slice. The current source-of-truth documents are sufficient to define the baseline.
