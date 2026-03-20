# Durable Round Evidence Handoff and Pause-Safe Persistence

## Problem
The previous active requirement slice is complete, so the product requirement artifact must be refreshed before implementation continues. The next slice needs to close a documentation gap exposed by evidence handoff failure risk: the current docs require compact evaluator handoffs and reviewable artifacts, but they do not yet define the minimum durable round record across evaluation packaging, summary generation, artifact write paths, pause semantics, and crash-safe persistence when a round is interrupted or evaluator infrastructure fails.

## Current Objective
Define exactly one documentation-first requirement slice for durable round evidence handoff. This slice must clarify how evaluation packaging, summary generation, artifact write paths, pause semantics, and crash-safe persistence stay consistent for a single round, especially when evaluator infrastructure fails, pause occurs before normal completion, or crash recovery resumes an interrupted round.

## User Value
Operators and later runtime roles can reliably inspect what happened in an affected round without confusing task-quality failure with loop-infrastructure failure. A round remains summary-first and reviewable while still preserving enough durable evidence to support safe pause, crash recovery, and governance decisions.

## Scope
- Define the documentation contract for reusing one round artifact path set across evaluation packaging, summary generation, and persisted round outputs.
- Define the minimum durable round record that must exist before the engine treats a round transition as safely complete.
- Define how evaluator infrastructure failure is recorded without dropping the round summary or artifact references.
- Define crash-recovery expectations for partially written round artifacts.
- Provide diff-ready documentation-only updates for the governing docs.
- Provide rerunnable verification steps for this requirement artifact.

## Non-Goals
- Code changes outside requirement documentation.
- Schema migrations or new storage backends.
- Changes to budget thresholds, scoring policy, or planner scope selection.
- UI redesign beyond documenting evidence visibility expectations.
- New speculative artifact types or workflow branches not required to preserve one round's durable evidence handoff.

## Acceptance Criteria
- The requirement slice explicitly states that evaluation packaging and summary generation must reuse the same round artifact write paths reserved for that round.
- The requirement slice explicitly defines the minimum durable round record required before transitions to `cooldown`, `paused`, `stopping`, or `error`.
- The requirement slice explicitly requires evaluator infrastructure failure to emit a persisted evaluation record that is distinguishable from ordinary task-quality failure.
- The requirement slice explicitly requires pause semantics to preserve durable evidence before a round is considered safely paused, except where crash recovery must take over after process death.
- The requirement slice explicitly requires crash-safe persistence to preserve partial round evidence, mark incomplete artifacts clearly, and surface those gaps through summary-first diagnostics instead of silent omission.
- The proposed documentation changes remain documentation-only and do not prescribe low-level implementation structure or round-level execution tasks.

## Design Expectations
- Human-facing diagnostics remain summary-first: show round outcome, evidence completeness status, failure class, and artifact references before any deep drill-down.
- If evidence is incomplete, the operator-visible summary and leader handoff must say which artifact is missing, incomplete, or unavailable instead of silently collapsing the gap into prose.
- Raw logs and large state-change artifacts remain drill-down material. Primary views should preserve pattern recognition through concise status, explicit artifact references, and targeted excerpts only.
- Evaluator infrastructure failure, normal evaluator fail, budget-triggered pause, and crash-recovery pause must remain visually and semantically distinct in operator-facing summaries.

## Proposed Documentation Changes

### `README.md`
No README change is required for this slice.

Reviewer rationale:

> `README.md` already establishes transparent history, summary-first handoff, navigational references, pause as a safety tool, and crash recovery as a product requirement. This slice only needs to tighten the workflow and persistence contract in the technical and runtime workflow docs.

### `ARCHITECTURE.md`
Update the round lifecycle, persistence, and crash recovery sections with the following diff-ready text.

Add the following requirement to `### 7.1 Phase 0: Preflight` after the timestamped artifact set is opened:

````md
- opening a new timestamped artifact set fixes the round's artifact write paths for that round; evaluation packaging, summary generation, pause diagnostics, and crash recovery must reuse that same path set rather than inventing new artifact paths mid-round.
````

Add the following requirements to `### 7.4 Phase 3: Evaluation`:

````md
- evaluation packaging must reference the current round's artifact write paths and may cite only artifacts that already exist or are explicitly marked incomplete for that same round.
- if evaluator infrastructure fails because of authentication, transport, tooling, or prompt-construction issues, the engine must still persist `*.round.evaluation.json` for that round with infrastructure-failure classification, the best available failure clue, and references to the same artifact write paths used by the round summary.
````

Add the following requirements to `### 7.5 Phase 4: Persist and Transition`:

````md
- before transitioning to `cooldown`, `paused`, `stopping`, or `error`, the engine must durably persist a minimum round record for the current artifact set: round summary, metrics, state-change evidence or explicit no-change note, and evaluation artifact or evaluator-infrastructure-failure record.
- pause semantics require that this minimum round record be written before the round is considered safely paused, unless the engine process dies first and crash recovery assumes responsibility for finishing the diagnostic record.
````

Replace the `*.round.summary.md` and `*.round.evaluation.json` semantics in `### 10.2 Artifact Semantics` with:

````md
- `*.round.summary.md`: human-readable summary of the round derived from the current round artifact set; it must reference the same artifact write paths used during evaluation packaging and explicitly mark missing or incomplete evidence instead of omitting the gap.
- `*.round.evaluation.json`: required evaluation record for every round outcome, including pass, fail, and evaluator infrastructure failure; it must preserve failure classification and references to the current round artifact set.
````

Add the following requirement to `## 11. Crash Recovery and Rollback`:

````md
- crash recovery must inspect the interrupted round's persisted phase and timestamped artifact set, preserve any partial artifacts already written, mark missing artifacts as incomplete, and transition to `paused` with a summary-first diagnostic instead of silently replacing or discarding evidence.
````

### `AILOOP_ENGINE_WORKFLOW.md`
Update the workflow narrative for evaluation, rework, and leader handoff with the following diff-ready text.

Add the following bullets under `Evaluation handoff rules`:

````md
- the compact evaluation brief and the round summary must point to the same round artifact write paths opened for that round.
- if evaluation cannot complete, the engine must still persist the round's evaluation artifact as evaluator infrastructure failure before handing control to pause handling or crash recovery.
````

Add the following bullet under `Rework handoff rule`:

````md
- if the round evidence set is incomplete, the rework handoff must explicitly identify which artifact is missing or incomplete instead of presenting the gap as ordinary task-quality failure.
````

Add the following bullet under `Phase 6: Leader / CCB Intervention`:

````md
- pause diagnostics and leader handoffs must explicitly show whether round evidence is complete, partially written, or missing, while preserving artifact references for drill-down.
````

## Verification Steps
Run the following commands:

```sh
rg -n "^## (Current Objective|Scope|Non-Goals|Acceptance Criteria|Design Expectations|Proposed Documentation Changes|Open Questions)$" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
rg -n "evaluation packaging|summary generation|artifact write paths|pause semantics|crash-safe persistence" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
```

Expected verification outcome:

- The first command lists the required sections for this active requirement slice.
- The second command shows the exact focus areas from the CCB hint in the active artifact.

## Open Questions
None. The mandatory source set is sufficient to define this documentation slice without expanding repository exploration.

## Lifecycle Status
- Status: active
- Created In Round: 124
- Previous Slice Status: complete in Round 123
- Completion Target: documentation alignment for durable round evidence handoff, not code implementation in this round
