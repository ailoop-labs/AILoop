# Round Summary Evidence Retention and Evaluation Artifact Emission

## Problem
The previous active requirement slice is complete, so the product requirement artifact must be refreshed before implementation continues. The next slice needs to define workflow-first documentation for how a round summary preserves evaluator and rework context, how evaluation artifacts are always emitted, and how raw evidence remains reviewable without dumping full bodies into downstream handoffs.

## Current Objective
Define exactly one implementation-ready, documentation-first slice for round-summary evidence retention and evaluation artifact emission semantics. This slice must require preserving evaluator and rework cycle history in round summaries, requiring evaluation artifacts for every round outcome, and keeping raw evidence available through navigational references instead of omission.

## User Value
Operators and later agents can audit what happened in each round without losing the evaluator or rework trail. The engine can stay summary-first for human consumption while still keeping raw evidence available through navigational references when deeper review is needed.

## In Scope
- Refresh `/Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md` as the active requirement artifact.
- Define one atomic documentation slice for rework cycle history retention in the round summary.
- Define one atomic documentation slice for evaluation artifacts that are emitted on every round, including pass, fail, and evaluator infrastructure failure paths.
- Define one atomic documentation slice for keeping raw evidence reviewable through navigational references and targeted excerpts instead of dropping it from summaries.
- Provide diff-ready proposed documentation changes for the governing docs that the next round can implement.
- Provide rerunnable verification steps for this refreshed requirement artifact.

## Acceptance Criteria
- The refreshed artifact contains `## Current Objective`, `## Acceptance Criteria`, `## Proposed Documentation Changes`, `## Verification Steps`, and `## Out of Scope`.
- The `## Current Objective` section explicitly requires preserving evaluator and rework cycle history in round summaries.
- The artifact explicitly requires evaluation artifacts to be emitted for every round outcome and uses the phrase `evaluation artifacts`.
- The artifact explicitly requires raw evidence to remain reviewable through `navigational references` and uses the phrase `raw evidence`.
- The proposed documentation changes are scoped to documentation updates only and do not require implementation work in this round.
- The verification section includes rerunnable commands that confirm the required headings and phrases exist in this artifact.

## Proposed Documentation Changes

### `README.md`
No README change is required for this slice.

Reviewer rationale:

> `README.md` already requires transparent history, raw evidence reviewability, and navigational handoff. This slice only needs to define the more specific workflow and artifact semantics in `ARCHITECTURE.md`.

### `ARCHITECTURE.md`
Update the workflow and artifact sections with the following diff-ready text.

Add the following requirement to the round workflow section that describes executor, evaluator, and rework handling:

````md
- `*.round.summary.md` must preserve evaluator and rework cycle history for the current round, including each evaluator decision, any executor rework attempt that followed, and the final round outcome.
````

Replace the `*.round.summary.md` and `*.round.evaluation.json` semantics in `### 10.2 Artifact Semantics` with:

````md
- `*.round.summary.md`: human-readable summary of the round that preserves evaluator and rework cycle history, links each cycle to the relevant artifact paths, and keeps raw evidence accessible through navigational references and targeted excerpts instead of embedding full artifact bodies.
- `*.round.evaluation.json`: evaluator decision artifact that must be emitted for every round, including pass, fail, and evaluator infrastructure failure outcomes, so evaluation artifacts are never omitted from the round record.
````

Add the following artifact composition requirement:

````md
- summary-first handoffs must keep raw evidence available through navigational references to log, state change, and evaluation artifacts rather than dropping or replacing that evidence with prose-only summaries.
````

If a contract section enumerates round outputs, extend it with:

````md
- round outputs always include a round summary and evaluation artifact, even when execution halts after evaluator infrastructure failure or governance pause.
````

## Verification Steps
Run the following commands:

```sh
rg -n "^## (Current Objective|Acceptance Criteria|Proposed Documentation Changes|Verification Steps|Out of Scope)$" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
rg -n "rework cycle history|evaluation artifacts|raw evidence|navigational references" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
```

Expected verification outcome:

- The first command lists all required headings in the active artifact.
- The second command shows the requirement phrases for rework cycle history, evaluation artifacts, raw evidence, and navigational references in the active artifact.

## Out of Scope
- Code changes outside requirement documentation
- UI work
- Runtime behavior changes
- Schema migrations
- Test-only refactors
- Speculative edge-case handling not required to define this slice
- Editing `/Users/yinjames/projects/AILoop/README.md` or `/Users/yinjames/projects/AILoop/ARCHITECTURE.md` in this round

## Lifecycle Status
- Status: active
- Prepared In Round: 123
- Completion Trigger: this slice is complete only after a later round updates the governing documentation to match these semantics
