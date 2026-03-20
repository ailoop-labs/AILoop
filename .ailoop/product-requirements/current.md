# External-Validation Action-Bloat Durable-Evidence Docs/Test Slice

## Problem
Round 125 completed the prior requirement refresh, so the active artifact must now be superseded by exactly one new requirement-only slice before further implementation continues. The next bounded gap is still documentation-first: the external-validation path already relies on persisted round artifacts and the durable evidence handoff contract, but the current active requirements do not yet define how the next docs/tests follow-up should describe and verify action bloat without expanding into runtime, UI, or architecture work.

## Current Objective
Define exactly one atomic requirement-only slice for the next external-validation docs/tests follow-up on action bloat. The next implementation round may update documentation and the smallest existing regression-test surface needed to explain and verify how action bloat is judged from the durable evidence handoff contract, using persisted round summaries, evaluation artifacts, metrics, and artifact paths. This round does not authorize code implementation.

## User Value
Operators and follow-on implementation rounds get a narrow contract for reviewing action bloat from evidence that already exists in persisted round artifacts. This keeps the next step reviewable and re-runnable while preventing scope drift into new telemetry, broader workflow redesign, or architectural expansion.

## Scope
- Refresh the active requirement artifact so it supersedes the completed prior slice from round 125 with one new active requirement-only slice.
- Limit the next follow-up to external-validation documentation and regression tests that explain how to detect action bloat from existing persisted round evidence.
- Define action bloat for this slice as action usage that exceeds, obscures, or cannot be clearly reconciled with the bounded task's persisted action budget evidence and the durable evidence handoff contract.
- Require the next follow-up to reuse the same persisted evidence bundle across operator-facing summaries, evaluator-facing diagnostics, and verification guidance instead of introducing alternate evidence paths.
- Keep the intended future implementation surface narrow: update `docs/plans/external-validation.md` and, only if needed, the smallest existing regression-test surface that already exercises external-validation evidence reporting or checklist rendering.
- Provide re-runnable verification steps for this refreshed requirement artifact only.

## Out of Scope
- Runtime implementation changes in `src/`.
- Server or API behavior changes.
- CLI behavior or command-surface changes.
- Schema, storage, or persistence-format changes.
- Web Console implementation or UI redesign work.
- Broader architectural, migration, infrastructure, or governance changes.
- New telemetry, new artifact types, or new metrics beyond the persisted evidence already captured for rounds.
- Running an actual external-validation pilot, creating new fixtures, or expanding the pilot scope beyond this docs/tests follow-up.

## Acceptance Criteria
- The refreshed artifact contains exactly one active slice centered on `external-validation` and `action bloat`.
- The refreshed artifact explicitly says, `This round does not authorize code implementation`.
- The refreshed artifact defines the next follow-up as documentation and regression-test work only, grounded in the durable evidence handoff contract.
- The refreshed artifact requires reuse of persisted round summaries, evaluation artifacts, metrics, and artifact paths as one evidence bundle for operator guidance, evaluator diagnostics, and verification.
- The refreshed artifact includes an `Out of Scope` section that explicitly excludes runtime, server, CLI, schema, Web Console, and broader architectural work.
- The refreshed artifact includes re-runnable verification commands that confirm the required sections and bounded-focus language are present.

## Design Expectations
- Summary-first evidence remains the default. The next docs/tests slice must describe action bloat using persisted summaries and linked artifacts before falling back to raw log inspection.
- The durable evidence handoff contract remains the source of truth for how persisted round evidence is traced across summary, evaluation, metrics, and artifact references.
- If existing persisted evidence is insufficient to explain a specific action-bloat case, the follow-up should document that limitation explicitly instead of treating this slice as permission for new runtime instrumentation.
- The next follow-up must stay small enough that existing tests can remain green without introducing unrelated product surfaces.

## Proposed Next Slice

### Documentation Target
Add a short subsection to `docs/plans/external-validation.md` that explains how the first pilot should review action bloat using persisted round action-budget evidence and the durable evidence handoff contract. The subsection should describe the minimum evidence chain as: summary references, evaluation artifact references, metrics evidence, and persisted artifact paths for the same round bundle.

### Regression-Test Target
If regression coverage is needed, constrain it to the smallest existing test surface that already exercises external-validation evidence reporting or checklist rendering. The test intent should be to prove that documented action-bloat guidance reuses existing persisted evidence consistently, not to add new behavior, new routes, or new presentation surfaces.

## Verification
Run the following commands:

```sh
rg -n "^## Current Objective|^## Out of Scope|^## Acceptance Criteria|^## Verification" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
rg -n "This round does not authorize code implementation|external-validation|action bloat|durable evidence handoff" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
```

Expected verification outcome:

- The first `rg` command returns matches for `## Current Objective`, `## Out of Scope`, `## Acceptance Criteria`, and `## Verification`.
- The second `rg` command returns matches for `This round does not authorize code implementation`, `external-validation`, `action bloat`, and `durable evidence handoff`.

## Open Questions
None. The project goal, prior durable-evidence documentation, and the senior-dev scoping hint are sufficient to define this bounded requirement-only slice without authorizing implementation.

## Lifecycle Status
- Status: ready
- Created In Round: 126
- Supersedes: round 125 requirement refresh marked complete
- Authorization: requirement-only slice; no code implementation is authorized in this round
