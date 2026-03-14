# ProjectPlanner and ProductManager Role Split

## Status

Proposed

## Source-of-Truth Position

This document is a proposal for future alignment. It does not override `README.md`, `ARCHITECTURE.md`, or `AILOOP_ENGINE_WORKFLOW.md`.

Until those higher-priority documents are updated, the current authoritative model remains:

- `README.md` as constitutional product intent and safety boundary
- `ARCHITECTURE.md` as the technical contract
- `AILOOP_ENGINE_WORKFLOW.md` as the current internal-agent workflow definition

This plan should therefore be read as:

- a diagnosis of current role ambiguity
- a proposed future role split
- a specification for what upstream document changes would be required before implementation

## Summary

This document proposes splitting the current overloaded planning responsibility into two distinct roles:

- `ProjectPlanner`: the round-level workflow owner that sequences work, detects missing requirements, tracks requirement completion, and emits one atomic execution task per round
- `ProductManager`: the product-planning role that writes and updates human-readable Markdown requirement documents when the project lacks sufficient product definition or when the current requirement slice has been completed

The immediate goal is not to rewrite the engine in one step. The immediate goal is to correct the role model in documentation first, then implement the new behavior incrementally.

## Problem

The current `Planner` role mixes two different types of work:

- product-definition work: deciding what should be built, what is in scope, what is out of scope, and what acceptance criteria should exist
- project-execution work: deciding what the next smallest round should do under current budget and failure constraints

This causes role ambiguity.

In practice, the current implementation behaves much more like a project-planning or iteration-planning role than a true product manager:

- it emits one atomic `SubTask` per round
- it reacts to evaluator failures and execution history
- it optimizes for round-level progress and verifiable evidence
- it does not produce durable product requirements as a first-class artifact

That mismatch makes the system harder to reason about and harder to supervise. A human operator reading "Planner" expects product-level intent shaping, but the runtime behavior is much closer to delivery management.

## Decision

We will adopt the following role model:

- The current runtime planning role is redefined as `ProjectPlanner`.
- A new `ProductManager` role is introduced for product planning only.
- `ProductManager` produces human-readable Markdown requirement documents.
- `ProjectPlanner` remains the only role that emits round-level execution tasks.
- `Executor` is not given step-by-step implementation scripts by the planner. It receives a round goal, constraints, and expected evidence, then determines the concrete implementation path itself.
- This change will be implemented through Documentation-Driven Development first. Code rename and runtime behavior changes will happen in separate phases.

## Proposed Workflow Adjustment

The proposed happy-path round workflow is:

`Human / README.md / GOAL.md -> ProjectPlanner -> ProductManager (when needed) -> ProjectPlanner -> Executor -> Evaluator -> ProjectPlanner -> Leader (if needed) -> job done`

This sequence does not remove the existing governance loop documented elsewhere. Auto-rework, budget pause behavior, Leader intervention, and CCB escalation remain in force unless and until the higher-priority documents are amended.

This sequence intentionally keeps `ProjectPlanner` in front of and behind the `ProductManager`:

- before `ProductManager`, `ProjectPlanner` decides whether product planning is needed
- after `ProductManager`, `ProjectPlanner` converts product requirements into the next round-level atomic task
- after `Evaluator`, `ProjectPlanner` decides whether to continue implementation, request updated product planning, or conclude that the requirement slice is complete

## Role Boundaries

### ProjectPlanner

`ProjectPlanner` is the workflow and iteration owner.

Responsibilities:

- read the top-level goal, human instructions, previous round state, and requirement artifacts
- detect when product requirements are missing, stale, contradictory, or already completed
- select the current requirement slice to advance
- emit exactly one atomic, verifiable round task
- maintain round-level momentum without expanding hidden scope
- decide when to wake `ProductManager`
- decide when the current requirement slice is complete and whether the project still needs more product planning

Non-responsibilities:

- writing detailed product requirements from scratch unless running a fallback clarification mode
- prescribing low-level code implementation steps
- evaluating its own success

### ProductManager

`ProductManager` is the product-definition owner.

Responsibilities:

- translate the top-level goal into a human-readable product requirement document
- define user value, scope, non-goals, acceptance criteria, design constraints, and open questions
- update the requirement document when the previous requirement slice is done and more product planning is needed
- keep requirements easy for a human operator to review directly in Markdown

Non-responsibilities:

- emitting round-level execution tasks
- instructing `Executor` directly
- deciding implementation details
- owning round budgets or rework mechanics

### Executor

`Executor` remains the implementation role.

Responsibilities:

- read the current round task and relevant requirement artifacts
- inspect current code and state before mutating
- choose the concrete implementation path
- validate outcomes with tests, commands, or other observable evidence

The key change is conceptual: `Executor` should not depend on `ProjectPlanner` for a detailed implementation recipe. It should operate from goals, constraints, and evidence expectations.

## Why This Split Is Better

This split separates two fundamentally different planning horizons:

- `ProductManager` works at the requirement and value-definition horizon
- `ProjectPlanner` works at the iteration and workflow horizon

Benefits:

- clearer role semantics for human operators
- better human supervision because requirements exist as reviewable Markdown
- less scope drift because requirement creation and task slicing are no longer mixed together
- better evaluator clarity because round-level evaluation can be judged against a stable requirement slice
- easier future extension to design work, since `ProductManager` can express design expectations without becoming an execution planner

## Product Requirement Artifact

The first-class output of `ProductManager` should be a Markdown artifact, not a JSON-only object.

Rationale:

- the project is still evolving and requires close human supervision
- Markdown is easier for the operator to review and edit
- human-readable requirements are more useful than opaque machine-only payloads during early-stage development

Recommended artifact location:

- `.ailoop/product-requirements/current.md`

Recommended structure:

```md
# Requirement Slice: <short title>

## Problem

## User Value

## Scope

## Non-Goals

## Acceptance Criteria

## Design / UX Requirements

## Constraints

## Open Questions

## Completion Notes
```

Notes:

- one file is enough for the MVP
- versioning can initially rely on normal run artifacts and git history
- if needed later, archived slices can live under `.ailoop/product-requirements/archive/`

## When ProjectPlanner Should Wake ProductManager

`ProductManager` should be invoked only when needed. It should not run every round.

Wake `ProductManager` when:

- no product requirement document exists
- the top-level goal has materially changed
- the current requirement document is too vague for safe execution
- repeated failures suggest the issue is missing or contradictory product definition rather than implementation
- the current requirement slice appears complete, but the overall project goal is not yet complete

Do not wake `ProductManager` when:

- the current requirement slice is clear and still has unfinished acceptance criteria
- the failure is clearly an implementation or evidence problem
- the round only needs ordinary engineering iteration

## How ProjectPlanner Determines Requirement Completion

`ProjectPlanner` should treat requirement completion as a supervision task, not an implementation guess.

The simplest MVP approach is:

- read the current requirement Markdown
- read the latest round evaluation result and state-change artifacts
- map evaluator evidence against the acceptance criteria
- determine whether all acceptance criteria for the current requirement slice are satisfied

If all criteria are satisfied:

- if the top-level goal is complete, stop
- if the top-level goal is not complete, wake `ProductManager` for the next requirement slice

If criteria are not satisfied:

- continue producing atomic implementation tasks against the current requirement slice

## Contract Changes

This proposal implies a future contract split.

### ProductManager output

Primary output:

- Markdown requirement artifact

Optional future structured sidecar:

- a small metadata file for requirement status tracking

### ProjectPlanner output

`ProjectPlanner` should continue to emit one round-level task, equivalent to the current `SubTask` contract.

The semantic change is:

- the task should reference the active requirement slice
- the task should describe the expected evidence clearly
- the task should not attempt to be a detailed implementation recipe

## Migration Strategy

This change should happen incrementally.

## Upstream Document Impact

This proposal cannot be treated as active architecture until the following documents are amended consistently:

- `ARCHITECTURE.md`, because it currently defines `Planner` as the sole planning contract that emits the round `SubTask` and shows a direct planner -> executor -> evaluator flow
- `AILOOP_ENGINE_WORKFLOW.md`, because it currently defines `PlannerAgent` as acting as the Product Manager and does not include a separate `ProductManager` role
- `README.md`, only if the product-facing system description should explicitly mention the new role split at the constitutional level

The intended order is:

1. approve this proposal
2. update `ARCHITECTURE.md` and `AILOOP_ENGINE_WORKFLOW.md`
3. update role definitions and user-facing terminology
4. implement runtime behavior changes
5. optionally perform mechanical code renames later

### Phase 1: Documentation alignment

Goals:

- document the new role model
- redefine current `Planner` semantics as `ProjectPlanner`
- define the `ProductManager` role and Markdown artifact
- define wake conditions and completion logic

Expected code changes:

- none

### Phase 2: Runtime behavior without large rename

Goals:

- add `ProductManager` role definition support
- add a minimal product-requirement artifact path
- allow current `PlannerAgent` implementation to behave as `ProjectPlanner`
- add logic for "wake ProductManager when needed"

Expected code changes:

- minimal engine and role-definition changes
- no forced global rename of symbols yet

### Phase 3: Terminology cleanup

Goals:

- rename user-facing labels from `Planner` to `ProjectPlanner`
- update logs, UI strings, and docs
- evaluate whether the code symbol `PlannerAgent` should be renamed to `ProjectPlannerAgent`

Expected code changes:

- mostly mechanical rename work

### Phase 4: Optional stronger requirement tracking

Goals:

- add lightweight status metadata for requirement slices
- support multiple requirement slices or archived slices
- improve evaluator-to-requirement traceability

Expected code changes:

- only after the basic split proves stable

## Explicit Non-Goals

This proposal does not aim to:

- redesign the entire governance model
- replace `Evaluator` with `ProductManager`
- make `ProductManager` run on every round
- turn `ProjectPlanner` into a detailed implementation planner
- force a full codebase-wide rename in one change
- introduce a heavy PRD system or complex requirement database

## Risks

### Risk: Two planners with overlapping authority

Mitigation:

- `ProductManager` writes requirements only
- `ProjectPlanner` emits execution tasks only
- `Executor` takes direction only from the current round task and approved artifacts

### Risk: ProductManager gets called too often

Mitigation:

- use explicit wake conditions
- treat `ProductManager` as a conditional upstream role, not a per-round mandatory role

### Risk: Requirement completion becomes subjective

Mitigation:

- keep acceptance criteria concrete
- require evaluator evidence to be referenced during completion checks
- start with one active requirement slice only

### Risk: Rename churn obscures behavior changes

Mitigation:

- separate semantic redefinition from mechanical code renaming
- land behavior changes before mass rename work

## Open Questions

- Should `ProductManager` maintain a single evolving requirement document or a sequence of requirement slices from the start?
- Should requirement completion be recorded directly in Markdown, in a sidecar JSON file, or both?
- Should `Leader` be allowed to wake `ProductManager` directly, or should all PM wake-ups flow through `ProjectPlanner`?
- Should the active requirement artifact live under `.ailoop/` or under `docs/` for easier human discovery?

## Recommended Next Step

After approving this document:

1. Update role definitions and workflow docs so the current `Planner` is described as `ProjectPlanner`.
2. Introduce a documented `ProductManager` role and a single Markdown requirement artifact path.
3. Implement the minimal runtime path that lets `ProjectPlanner` request `ProductManager` output when requirements are missing or completed.
4. Delay any mass rename of code symbols until the new role split is proven in practice.
