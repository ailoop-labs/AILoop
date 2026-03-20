# External-Validation Action-Bloat Evidence Reporting Slice

## Problem
Rounds 128 through 133 already advanced and verified the evaluator-history, paused-artifact, and governance-bundle evidence slice, so the current active requirement artifact is stale. The next bounded gap is to restore the deferred external-validation action-bloat follow-up and define how operators should review and report action-heavy rounds from persisted evidence without reopening runtime instrumentation, new storage, or governance-policy work.

## Current Objective
Define exactly one atomic next slice for external-validation action-bloat evidence reporting. The next implementation round may update `/Users/yinjames/projects/AILoop/docs/plans/external-validation.md` and the smallest existing regression-test surface that already exercises external-validation reporting or friction-routing language so the product documents and verifies how action bloat is reported from persisted round summaries, evaluation artifacts, budget metrics, and artifact paths. This round does not authorize code implementation.

## User Value
Operators get a current, reviewable contract for spotting action bloat from evidence that is already persisted for each round. Follow-on implementation stays bounded to existing evidence surfaces, which reduces drift into speculative telemetry, unclear escalation rules, or another stale documentation handoff.

## Scope
- Refresh `/Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md` so it supersedes the stale evaluator-evidence slice with one new active slice.
- Bound the next follow-up to external-validation documentation and the smallest existing regression-test surface that already covers external-validation reporting or friction-routing language.
- Define action bloat for this slice using persisted `budget_usage.actionsUsed`, `budget_limits.actions`, stable task identity, and the same-round summary, evaluation, metrics, and artifact references.
- Require the next follow-up to keep action-bloat reporting descriptive unless the already documented escalation triggers are actually met.
- Require the next follow-up to prove that below-threshold action-bloat cases are reported without incorrectly implying or routing to CCB escalation.
- Reuse the durable evidence handoff contract across summary, evaluation artifact, metrics, and artifact paths instead of introducing alternate telemetry or hidden heuristics.
- Keep the intended future implementation surface narrow: update `/Users/yinjames/projects/AILoop/docs/plans/external-validation.md` and, only if a regression proves missing output, the smallest existing reporting text path and tests that already exercise this external-validation evidence flow.
- Provide re-runnable verification commands for this refreshed requirement artifact only.

## Out of Scope
- Runtime implementation changes in `src/` during this refresh round.
- New telemetry collectors, new artifact types, or new checklist metrics beyond the persisted round evidence already written today.
- Server or API surface expansion.
- CLI command-surface expansion.
- Schema, storage, or persistence-format changes.
- Web Console implementation or UI redesign work.
- Changing Leader or CCB escalation thresholds, README policy, or broader governance rules.
- Running a real external-validation pilot, creating new fixtures, or broad architectural, migration, or infrastructure work.

## Acceptance Criteria
- The refreshed artifact defines exactly one active slice centered on external-validation action-bloat evidence reporting.
- The refreshed artifact explicitly states `This round does not authorize code implementation`.
- The refreshed artifact limits the next follow-up to `/Users/yinjames/projects/AILoop/docs/plans/external-validation.md` and the smallest existing regression-test surface, with only the smallest existing reporting text path allowed if a regression proves missing output.
- The refreshed artifact requires action-bloat evidence to be derived from persisted action budget usage and limits, stable task identity, and the same-round summary, evaluation, metrics, and artifact references.
- The refreshed artifact requires proof that below-threshold action-bloat cases are reported without incorrectly escalating to CCB.
- The refreshed artifact forbids new telemetry or alternate evidence paths for this slice.
- The refreshed artifact includes the mandated `Out of Scope` exclusions for runtime, server, CLI, schema/storage, Web Console, governance-threshold changes, and broader architectural work.
- The refreshed artifact embeds re-runnable verification commands that confirm the required sections and bounded-focus phrases are present.

## Design Expectations
- Summary-first evidence remains the default. The next slice should explain action bloat from persisted summaries first, then link to evaluation artifacts, metrics, and artifact paths for the same round bundle.
- Stable task identity must remain explicit so repeated pilot work is reviewed by `stable_id` rather than summary prose or title matching.
- Action-bloat reporting should stay descriptive when the documented friction thresholds are not met. This slice should not reinterpret ordinary high-action evidence as an automatic CCB trigger.
- If the current persisted evidence is insufficient to explain a specific action-bloat case, the next follow-up should document that limitation explicitly instead of inventing new runtime instrumentation.

## Proposed Next Slice

### Documentation Target
Add a short subsection to `/Users/yinjames/projects/AILoop/docs/plans/external-validation.md` that explains how operators review action bloat per stable task identity from the existing evidence bundle: summary references, evaluation artifact references, metrics budget usage and limits, and persisted artifact paths for the same round.

### Regression-Test Target
If regression coverage is needed, constrain it to the smallest existing test surface that already exercises external-validation reporting or friction-routing language. The test intent should be to prove that action-bloat evidence is reported from existing persisted evidence and that non-threshold cases remain non-CCB.

## Verification
Run the following commands:

```sh
rg -n "^## Current Objective|^## Out of Scope|^## Acceptance Criteria|^## Verification" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
rg -n "external-validation|action-bloat|stable task identity|CCB|threshold|durable evidence handoff|This round does not authorize code implementation" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
git -C /Users/yinjames/projects/AILoop diff --name-only
```

Expected verification outcome:

- The first `rg` command returns matches for `## Current Objective`, `## Out of Scope`, `## Acceptance Criteria`, and `## Verification`.
- The second `rg` command returns matches for `external-validation`, `action-bloat`, `stable task identity`, `CCB`, `threshold`, `durable evidence handoff`, and `This round does not authorize code implementation`.
- The `git diff --name-only` command returns only `.ailoop/product-requirements/current.md`.

## Open Questions
None. The prior evaluator-evidence rounds, the deferred external-validation handoff, and the QA hint on below-threshold reporting provide enough context to define this bounded next slice without broadening scope.

## Lifecycle Status
- Status: active
- Active In Round: 134
- Supersedes: the evaluator-evidence slice that was advanced by rounds 128 through 133
- Next Authorized Work: refresh `/Users/yinjames/projects/AILoop/docs/plans/external-validation.md` and the smallest existing regression tests in a later round
- Implementation Authorization: none in this round; the next round may perform the bounded docs/tests follow-up described above
