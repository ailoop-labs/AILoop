# Requirement Slice: Reviewable Round Evidence for Operator Trust

## Problem
AILoop promises transparent history and safe human supervision, but a round is not truly reviewable if the persisted evidence does not clearly connect the reported actions, the material state change, and the validation result. When that causal chain is weak or contradictory, the Evaluator pauses progress and the operator must reconstruct reality from raw logs instead of using concise artifacts.

## User Value
Operators can decide whether to resume, pause, stop, or override a run quickly because the round record is trustworthy at a glance. ProjectPlanner and Evaluator can work from the same durable evidence instead of inferring missing context. This reduces wasted rounds caused by auditability gaps rather than product progress.

## Why Now
Recent run history shows a concrete failure mode: a round can appear directionally correct yet still fail on causal validity because the executor-facing account, persisted diff, and verification evidence do not line up cleanly enough for downstream review. This slice addresses that trust gap directly without broadening MVP scope.

## In Scope
- Make one round's persisted artifacts sufficient for a human operator to understand what was attempted, what materially changed, how it was verified, and why it passed or failed.
- Keep the executor-facing account, state-change record, evaluation record, and summary mutually consistent when a round makes material changes.
- Preserve operator-visible evidence for post-pass operational follow-up or rollback guidance when those signals exist.
- Ensure operator-facing review surfaces expose the active requirement context and a compact round evidence summary without requiring full raw-log parsing.
- Preserve secret redaction across all round evidence surfaces.

## Non-Goals
- Redesigning the evaluator rubric or adding new evaluation dimensions.
- Building a new telemetry platform or storing every raw model token.
- Expanding into multi-run analytics, multi-tenant features, billing, or plugin marketplace work.
- Rewriting the engine workflow, budget model, or governance flow beyond the minimum alignment needed for this slice.

## Acceptance Criteria
- A human reviewing the persisted round outputs can answer, without consulting hidden prompts, all of the following: what objective the round attempted, what materially changed, what verification ran, and why the round passed or failed.
- Material mutations are reflected consistently across the executor-facing account and the persisted state-change evidence. The artifacts must not tell conflicting stories about what changed.
- When evaluation fails because evidence is incomplete or contradictory, the persisted failure reason identifies the missing or conflicting evidence clearly enough for ProjectPlanner to choose one corrective next step without inventing new scope.
- If a round records operational follow-up or rollback guidance, that information appears in durable artifacts and in the operator-visible run detail for the same round.
- Secret-like values remain redacted in logs, summaries, state-change artifacts, and evaluation evidence.
- This slice is complete when one recent round can be audited end-to-end from persisted artifacts and operator-visible summaries without manual reconstruction of omitted steps.

## Design / Observability Expectations
- Prefer compact, labeled evidence summaries over long narrative prose.
- Preserve high-bandwidth UX: operators should be able to scan objective, status, changed surface, verification result, and recovery note quickly.
- If console changes are needed, they must stay aligned with artifact changes and emphasize pattern recognition rather than raw text volume.
- The Web Console remains a first-class governance surface; artifact improvements that affect operator understanding must have console parity.

## Constraints
- Keep the solution minimal and literal. Do not introduce a speculative observability subsystem.
- Preserve pause as the default safety response when evidence is insufficient.
- Preserve budget enforcement, recoverability where supported, and documentation precedence over code.
- Do not weaken evaluator skepticism to compensate for poor evidence quality.
- Keep this slice narrow enough for one or a few atomic rounds.

## Open Questions
- None blocking for this slice.
- If operators later need denser visual signal, decide whether the compact evidence summary should be rendered primarily as a checklist, a timeline, or status cards. That is follow-up work, not part of this slice.
