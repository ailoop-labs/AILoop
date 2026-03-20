# Evaluator Rework History Evidence Requirement Slice

## Problem
The active requirement artifact must be refreshed before any implementation resumes. The next bounded gap is narrower than the prior external-validation slice: the evaluator follow-up now needs a documentation-first requirement that defines how the next round will prove three behaviors without broadening scope. Those behaviors are that evaluator history survives two rework cycles, evaluation artifacts are written on pause/failure paths, and summary-first outputs preserve traceability back to persisted evidence.

## Current Objective
Define exactly one atomic, requirement-only slice for the next evaluator follow-up. The next authorized implementation round may update documentation and the smallest existing regression-test surface needed to prove that evaluator history survives two rework cycles, evaluation artifacts are written on pause/failure paths, and summaries remain summary-first without losing traceability to persisted artifacts. This round does not authorize code implementation.

## User Value
Operators and follow-on executor rounds get a precise contract for verifying evaluator durability and evidence handoff behavior without guessing at intent. This keeps the next step reviewable, re-runnable, and constrained to existing evidence surfaces instead of drifting into unrelated product changes.

## Scope
- Refresh `/Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md` so it supersedes the prior slice with one new active requirement-only slice.
- Bound the next follow-up to documentation and the smallest existing regression-test surface that can prove evaluator history survives two rework cycles.
- Require the next follow-up to prove evaluation artifacts are written on pause/failure paths using existing persisted artifact locations and evidence flows.
- Require the next follow-up to preserve summary-first handoffs while keeping clear traceability through summaries, evaluation artifacts, metrics, and artifact paths for the same round evidence bundle.
- Keep the intended future implementation surface narrow: update only the relevant requirement-following docs and the smallest existing tests that already exercise evaluator history or evidence-writing behavior.
- Provide re-runnable verification commands for this refreshed requirement artifact only.

## Out of Scope
- Runtime implementation changes in `src/`.
- Server or API behavior changes.
- CLI behavior changes.
- Schema/storage/persistence-format changes.
- Web Console implementation or UI work.
- Broader architectural, migration, infrastructure, or governance changes beyond defining this single requirement slice.

## Acceptance Criteria
- The refreshed artifact defines exactly one atomic next slice focused on evaluator history durability across two rework cycles, pause/failure evaluation artifacts, and summary-first traceability.
- The refreshed artifact explicitly states `This round does not authorize code implementation`.
- The refreshed artifact limits the next implementation round to documentation and the smallest existing regression-test surface only.
- The refreshed artifact requires proof that evaluator history survives two rework cycles without losing prior evaluation context.
- The refreshed artifact requires proof that evaluation artifacts are written on pause/failure paths.
- The refreshed artifact requires proof that summaries remain summary-first while retaining traceability to persisted evidence.
- The refreshed artifact includes the mandated `Out of Scope` exclusions for runtime, server, CLI, schema/storage/persistence, Web Console, and broader architectural work.
- The refreshed artifact embeds re-runnable verification commands that confirm the required sections and bounded-focus phrases are present.

## Design Expectations
- Summary-first remains the default presentation rule: the next slice must describe evaluator outcomes from concise summaries first, then link to supporting artifacts and metrics.
- Traceability must stay explicit: summaries, evaluator history, evaluation artifacts, and persisted artifact paths must describe one coherent evidence chain for the same rounds.
- Pause/failure handling must be verified from existing evidence-writing behavior and current artifact locations, not by inventing new storage mechanisms.
- Two rework cycles means the documented proof must cover the original evaluation plus two successive rework evaluations and show the history remains reviewable end to end.

## Proposed Next Slice

### Documentation Target
Add or update the smallest documentation surface that explains how evaluator history across two rework cycles is inspected, how pause/failure evaluation artifacts are expected to exist, and how summary-first reporting retains traceability to the underlying evidence bundle.

### Regression-Test Target
If regression coverage is required, constrain it to the smallest existing test surface that already exercises evaluator history retention, evaluation artifact writing, or summary/evidence handoff behavior. The test intent should be to prove the documented contract, not to introduce new runtime behavior or broaden the product surface.

## Verification
Run the following commands:

```sh
rg -n "^## Current Objective|^## Out of Scope|^## Acceptance Criteria|^## Verification" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
rg -n "two rework cycles|pause/failure|evaluation artifacts|summary-first|traceability|This round does not authorize code implementation" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
git -C /Users/yinjames/projects/AILoop diff --name-only
```

Expected verification outcome:

- The first `rg` command returns matches for `## Current Objective`, `## Out of Scope`, `## Acceptance Criteria`, and `## Verification`.
- The second `rg` command returns matches for `two rework cycles`, `pause/failure`, `evaluation artifacts`, `summary-first`, `traceability`, and `This round does not authorize code implementation`.
- The `git diff --name-only` command returns only `.ailoop/product-requirements/current.md`.

## Lifecycle Status
- Status: active
- Active In Round: 127
- Next Authorized Work: refresh supporting documentation and the smallest existing regression tests in a later round
- Implementation Authorization: none in this round
