# Phase 3 External Validation Path

## Problem
AILoop now has the Phase 3 groundwork needed to inspect external-validation readiness in the Web Console: candidate-repository preflight, the manual pre-run checklist, the read-only `First Pilot Scope` boundary, aggregate checklist metrics, baseline-vs-pilot checklist comparison, and per-task pilot telemetry drill-down are already shipped.

The active requirement is stale because it still treats the completed `First Pilot Scope` panel as the next implementation target. That makes the next Phase 3 round ambiguous and breaks the documentation-first rule. The next slice needs to stay narrow and build directly on the existing checklist plus per-task drill-down instead of reopening already-completed scope.

## Outcome
The active Phase 3 requirement points to one remaining bounded observability slice: task-level baseline comparison inside the existing external-validation checklist. Operators can compare pilot task telemetry against a self-iteration baseline for the same `stable_id` without leaving the current checklist view, and the requirement clearly states what remains deferred.

## Scope
- Refresh the active requirement away from the completed `First Pilot Scope` UI slice.
- Define one new narrow Phase 3 slice: task-level baseline comparison in the existing external-validation checklist.
- Reuse the existing baseline overlay and per-task pilot telemetry instead of inventing a new Phase 3 workflow.
- Match pilot tasks to baseline tasks by `stable_id`.
- For each matched task, compare:
  - rounds
  - human interventions
  - average cost per round
  - evaluator infrastructure failures
  - hot-file growth
- Keep the presentation summary-first and read-only inside the current checklist drill-down.
- Make the fallback behavior explicit when a pilot task has no matching baseline task.

## Completed Groundwork
- Candidate repository preflight is already shipped.
- Aggregate external-validation checklist metrics are already shipped.
- Baseline-vs-pilot checklist comparison is already shipped at the aggregate level.
- The manual pre-run verification checklist is already shipped.
- The read-only `First Pilot Scope` boundary is already shipped.
- Per-task pilot telemetry drill-down is already shipped.

## Concrete Scope Cut Proposal
- Behavior change:
  - Extend the current `External Validation Checklist` drill-down so each pilot task can show baseline, pilot, and delta values when an aggregate baseline overlay is active.
  - Pair task-level comparisons by `stable_id`; do not infer matches from task titles or objectives.
  - Show a clear pilot-only fallback when a task has no baseline match.
  - Preserve the existing aggregate checklist cards and current task drill-down; add task-level comparison detail only.
- Files and surfaces affected:
  - `.ailoop/product-requirements/current.md`
  - `docs/plans/external-validation.md`
  - `src/types/contracts.ts`
  - `src/reporting/metrics.ts`
  - `src/reporting/metrics.test.ts`
  - `src/server.ts`
  - `src/server.test.ts`
  - `web/src/App.tsx`
  - `web/src/App.test.tsx`

## Out of Scope
- Reworking or replacing the shipped `First Pilot Scope` panel
- Running a real external-validation pilot
- Selecting or cloning repositories automatically
- Persisting task-level comparison state or baseline selections
- Adding new external-validation metrics beyond the five documented checklist metrics
- Changing aggregate checklist math or existing pilot telemetry formulas
- Adding per-task comparisons to the CLI report
- Multi-repo comparisons or repository history views
- Backend governance-rule changes, evaluator-threshold changes, or budget-policy changes
- Broad Web Console redesign outside the existing checklist and task drill-down

## Non-Goals
- Do not reopen Phase 3 repository preflight criteria.
- Do not change the current candidate-repository eligibility gates.
- Do not add automation for pilot execution.
- Do not mix actual pilot execution with this observability slice.

## Acceptance Criteria
- The active requirement names task-level baseline comparison, not the already-shipped `First Pilot Scope` panel, as the next implementation target.
- The requirement states that baseline-task matching uses `stable_id`.
- The requirement limits task-level comparison to the five existing checklist metrics.
- The requirement defines explicit fallback behavior for pilot tasks with no baseline match.
- The requirement includes an explicit `Out of Scope` section that excludes pilot execution, persistence work, CLI expansion, and broad console redesign.
- The impacted surfaces are limited to the existing reporting, API, and checklist-view layers needed for this slice.

## UX and Observability Notes
- Keep the checklist summary-first: aggregate cards stay at the top, task-level deltas stay inside the existing drill-down.
- Operators should be able to tell the difference between a matched comparison and a pilot-only task at a glance.
- Missing baseline coverage is useful evidence; render it explicitly instead of hiding the task.

## Dependencies and Assumptions
- Stable sub-task identities are already persisted and available in pilot and baseline metrics.
- Aggregate baseline comparison remains the source-of-truth switch for whether baseline data is active in the checklist.
- Existing task telemetry already exposes the five metrics needed for per-task comparison.

## Open Questions
- Should unmatched pilot tasks be grouped into a separate `Pilot-only` subsection, or stay inline with a missing-baseline badge?
- Should task-level deltas use the same "lower is better" treatment as the aggregate checklist cards, or a more neutral presentation?
