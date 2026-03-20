# External-Validation Action-Bloat Docs/Test Requirement Refresh

## Problem
The previous active requirement slice is complete, and the requirement artifact must be refreshed before normal implementation continues. The next bounded gap is narrower than runtime or UI feature work: the external-validation path already documents a deliberately small first pilot and already persists durable round evidence, but the active requirement set does not yet define how action bloat should be constrained in the external-validation docs/tests slice. Without a refreshed requirement, later work could sprawl into new metrics, new UI scope, or architecture changes instead of tightening the existing documentation and regression-test contract around persisted action evidence.

## Current Objective
Define exactly one documentation-first requirement slice for the external-validation docs/tests follow-up on action bloat. This slice must state how later work should document and test bounded action usage by reusing the durable round evidence handoff contract that now governs round summaries, evaluation records, and persisted artifact paths. This round does not authorize code implementation.

## User Value
Operators and follow-on implementation rounds get a narrow, reviewable contract for evaluating action bloat in the first external-validation pilot path. Later changes can stay small, evidence-backed, and re-runnable because they must rely on persisted round metrics and summary-first diagnostics instead of ad hoc logs or broad workflow expansion.

## Scope
- Refresh the active requirement artifact so it no longer points at the completed durable-evidence slice.
- Define action bloat for the external-validation path as excess or unclear action usage relative to persisted round budget evidence, using existing round metrics and artifact references rather than new telemetry systems.
- State that the follow-up is limited to documentation and regression-test surfaces for external-validation guidance and evidence checks.
- Require the later docs/tests slice to stay aligned with the durable round evidence handoff contract: summary, evaluation, and verification must all point back to the same persisted round evidence.
- Provide re-runnable verification steps for this refreshed requirement artifact only.

## Out of Scope
- Runtime, server, reporting, CLI, schema, or Web Console implementation changes in this round.
- New external-validation metrics, new artifact types, or changes to round persistence semantics.
- Broad action-budget redesign, governance-policy changes, or constitutional reinterpretation.
- Running an actual pilot, mutating test fixtures, or expanding external-validation beyond the existing bounded first-pilot path.
- Architecture or UI expansion unrelated to the narrow docs/tests action bloat follow-up.

## Acceptance Criteria
- The refreshed artifact explicitly names `external-validation` and `action bloat` as the only active follow-up topic.
- The refreshed artifact explicitly states that this round is requirement-only and does not authorize code implementation.
- The refreshed artifact defines the future slice as docs/tests-only and ties it to existing persisted budget evidence rather than new runtime instrumentation.
- The refreshed artifact explicitly references the durable round evidence handoff contract and requires future verification to reuse the same persisted round evidence across summary, evaluation, and diagnostics.
- The refreshed artifact includes an `Out of Scope` section that forbids unrelated code, architecture, or UI expansion.
- The refreshed artifact includes re-runnable verification commands that confirm the file was refreshed and still contains the required scope-guard sections and focus terms.

## Design Expectations
- Summary-first evidence remains the default: any future external-validation action-bloat documentation or tests must rely on persisted round metrics, evaluation artifacts, and summary references before considering raw logs.
- The follow-up must stay deliberately narrow. If the existing persisted budget evidence is insufficient, that gap should be documented explicitly instead of using the requirement as permission to broaden runtime scope.
- Regression tests in the later slice should validate documented evidence usage and scope boundaries, not introduce speculative behavior or alternate workflows.
- Later docs/tests work must preserve the first-pilot discipline already documented for external-validation: one repository, one bounded task, and reviewable evidence.

## Proposed Documentation/Test Follow-Up

### `docs/plans/external-validation.md`
Add a small follow-up subsection that defines how the first pilot should judge action bloat from persisted round budget evidence. The subsection should describe action bloat as action usage that exceeds, obscures, or cannot be clearly reconciled with the bounded task's persisted action budget and round summary artifacts.

### Regression-Test Expectations
Limit the next implementation slice to tests and documentation that prove the external-validation path consumes existing persisted action evidence consistently. Candidate regression surfaces may include the external-validation reporting tests, control/report CLI tests, and console-facing tests, but only where they verify documented reuse of existing round evidence rather than introduce new feature scope.

### Durable Evidence Constraint
Any later docs/tests update for action bloat must reuse the durable evidence handoff contract already documented for round summaries and evaluation artifacts. The same persisted round evidence should remain traceable from verification guidance, evaluator-facing diagnostics, and operator-facing summaries.

## Verification
Run the following commands:

```sh
git -C /Users/yinjames/projects/AILoop diff --name-only
rg -n "Out of Scope|Acceptance Criteria|Verification|external-validation|action bloat" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
```

Expected verification outcome:

- The `git diff --name-only` output includes `.ailoop/product-requirements/current.md`.
- The `rg` output returns matches for the required sections and the narrow external-validation action-bloat focus terms.

## Open Questions
None. The goal, senior-dev instruction, and durable evidence handoff contract are sufficient to refresh the active requirement artifact without expanding scope.

## Lifecycle Status
- Status: active
- Created In Round: 125
- Previous Slice Status: complete in Round 124
- Completion Target: requirement refresh for the narrow external-validation docs/tests action-bloat follow-up; no code implementation in this round
