# ProjectPlanner and ProductManager Implementation Plan

## Status

Implemented

## Purpose

This document converts the approved ProjectPlanner/ProductManager direction into an implementation sequence that can be executed incrementally without violating Documentation-Driven Development.

It covers all changes implied by this conversation:

- redefine `Planner` as `ProjectPlanner`
- introduce `ProductManager` as a runtime product-definition role
- keep human-readable Markdown requirement artifacts as the primary PM output
- preserve existing governance, budget, and pause behavior
- reuse the current role-generation infrastructure instead of replacing it

## Current Baseline

The following groundwork is already complete:

- upstream documentation has been aligned in `ARCHITECTURE.md` and `AILOOP_ENGINE_WORKFLOW.md`
- the proposal and rationale have been captured in `docs/plans/2026-03-14-project-planner-product-manager-split.md`
- role-generation infrastructure now supports `product_manager`
- default role templates and current `.ailoop/*ROLE.md` files have been updated to the new semantics

The runtime behavior and control-plane integration described in this plan have now been implemented. The remaining work is limited to optional mechanical cleanup, such as broad internal symbol renames, and ordinary follow-up maintenance.

## Completion Snapshot

The following phases are complete:

- Phase 1: Requirement Artifact Foundation
- Phase 2: Add ProductManager Runtime Agent
- Phase 3: Teach ProjectPlanner to Manage Requirement Lifecycle
- Phase 4: Engine Integration for ProductManager Wake-Up
- Phase 5: Requirement Completion Checks
- Phase 6: Control Plane and Observability Alignment
- Phase 7: Terminology and Cleanup

Implementation-level verification completed with:

- targeted runtime and UI tests during each phase
- full `bun test`
- `bun run typecheck`
- `bun run web:build`

Stabilization follow-up completed after the main rollout:

- added `.ailoop/context/core_paths.json` so repository-level context tests pass consistently
- aligned remaining role and built-in skill wording with `ProjectPlanner` / `ProductManager` semantics

## Implementation Principles

- prefer narrow vertical slices over a big-bang rewrite
- keep current engine contracts working while adding the new path
- add tests before behavior changes
- maintain backward compatibility where possible for file names and runtime labels until migration is complete
- preserve evaluator, budget, pause, and governance behavior unless explicitly changed in documentation

## Scope

### In Scope

- product requirement Markdown artifact creation and refresh flow
- runtime `ProductManager` invocation when requirements are missing, stale, or complete
- `ProjectPlanner` requirement-aware planning
- requirement completion checks based on evaluator evidence
- terminology alignment in control/UI surfaces where needed

### Out of Scope

- redesign of CCB or Leader governance
- replacing the `SubTask` contract with a new execution protocol
- multi-requirement database modeling beyond a minimal active slice
- introducing a complex PRD management subsystem

## Delivery Sequence

### Phase 1: Requirement Artifact Foundation

Goal:

- introduce the minimal persistent artifact model for product requirements

Files:

- modify `src/types/contracts.ts`
- modify `src/loop/state.ts`
- create `src/product/requirements.ts` or equivalent helper module
- create tests in `src/product/requirements.test.ts`

Changes:

- define the canonical active requirement path, initially `.ailoop/product-requirements/current.md`
- add helpers to ensure the product requirement directory exists
- add helpers to read, write, and inspect the active requirement artifact safely
- keep the first version Markdown-only; no sidecar metadata yet

Tests:

- active requirement path is created idempotently
- missing requirement file can be detected without throwing
- writing the artifact produces stable Markdown output

Acceptance:

- engine-adjacent code can reliably ask “does the active requirement artifact exist?” and “what is its current content?”

### Phase 2: Add ProductManager Runtime Agent

Goal:

- introduce a runtime `ProductManagerAgent` that can produce or refresh the requirement Markdown artifact

Files:

- create `src/agent/product-manager.ts`
- create `src/agent/product-manager.test.ts`
- modify `src/agent/role-definitions.ts` only if additional helper exposure is needed
- optionally create `.ailoop/PRODUCT_MANAGER_ROLE.md` fixtures in tests

Changes:

- define a `ProductManagerContext` with goal, instructions, prior requirement content, and prior round signals
- generate Markdown output, not `SubTask` JSON
- load the project-specific `PRODUCT_MANAGER_ROLE.md`
- enforce deterministic fallback behavior when the LLM call fails or returns unusable output

Tests:

- prompt contains the product manager role definition
- successful output is normalized to Markdown
- fallback produces a usable requirement skeleton
- no execution-task JSON is produced by this agent

Acceptance:

- runtime can invoke `ProductManagerAgent` independently from `ProjectPlanner`

### Phase 3: Teach ProjectPlanner to Manage Requirement Lifecycle

Goal:

- make planning requirement-aware without rewriting the existing planner/executor/evaluator loop

Files:

- modify `src/agent/planner.ts`
- modify `src/agent/planner.test.ts`
- modify `src/types/contracts.ts`
- optionally create `src/planning/requirement-signals.ts`

Changes:

- extend planner context with a requirement summary or active requirement status
- add planner logic for three cases:
  - no requirement artifact exists
  - requirement artifact exists and is still actionable
  - requirement artifact appears complete or insufficient
- keep planner output as one atomic `SubTask`
- do not turn planner output into low-level implementation steps

Tests:

- planner chooses a requirement-creation or requirement-refresh path when requirements are missing
- planner continues normal implementation planning when requirements are sufficient
- planner does not emit multiple tasks

Acceptance:

- planner can distinguish between “need product definition” and “continue execution” deterministically

### Phase 4: Engine Integration for ProductManager Wake-Up

Goal:

- wire the optional `ProductManager` hop into the round flow with minimal intrusion

Files:

- modify `src/loop/engine.ts`
- modify `src/loop/engine.test.ts`
- modify `src/loop/engine.summary-artifact.test.ts` if summary content changes

Changes:

- instantiate `ProductManagerAgent` in the engine
- before normal planning finalization, inspect requirement state
- if the planner indicates requirement generation or refresh is needed, invoke `ProductManager`
- persist the resulting Markdown artifact
- re-enter normal planning within the same round using the refreshed requirement artifact, if budget permits
- otherwise pause safely with explicit evidence

Tests:

- missing requirement artifact triggers ProductManager before normal execution
- refreshed requirement artifact is persisted to the expected path
- engine still emits one execution `SubTask`
- budget checks still guard the new PM step

Acceptance:

- the happy path becomes: detect requirement need -> generate requirement Markdown -> continue to round planning -> execute

### Phase 5: Requirement Completion Checks

Goal:

- let the system decide when the current requirement slice is complete

Files:

- modify `src/loop/engine.ts`
- modify evaluator-adjacent code as needed
- create `src/planning/requirement-completion.test.ts` or equivalent

Changes:

- define the simplest MVP completion heuristic:
  - read active requirement Markdown
  - inspect evaluator decision, evidence, and state-change artifact
  - compare evidence against acceptance criteria text
- when criteria are all satisfied:
  - stop if the top-level goal is done
  - otherwise request ProductManager refresh for the next requirement slice

Tests:

- satisfied acceptance criteria mark the current slice complete
- incomplete criteria continue normal planning
- evaluator failure alone does not incorrectly mark completion

Acceptance:

- planner no longer relies only on vague round history; it can reason against explicit product criteria

### Phase 6: Control Plane and Observability Alignment

Goal:

- expose the new roles and artifacts clearly to the operator

Files:

- modify `src/loop/control.ts`
- modify `src/server.ts` and related tests
- modify Web Console code under `web/` as needed

Changes:

- show `Project Planner` and `Product Manager` in role views
- expose the active requirement artifact in status/history APIs where appropriate
- make it easy to inspect current requirement Markdown from the Web Console
- preserve high-bandwidth UX principles rather than dumping raw text blobs into the main timeline

Tests:

- role listing includes ProductManager
- status/history surfaces can return the active requirement artifact path or summary
- server tests confirm the new fields are safe and stable

Acceptance:

- a human operator can tell what requirement slice is active and which role produced it

### Phase 7: Terminology and Cleanup

Goal:

- finish the migration from old labels to the new semantics after runtime behavior is proven

Files:

- search and update `Planner` user-facing labels where they are semantically stale
- optionally rename code symbols only after behavior is stable

Changes:

- rename UI strings, summaries, and logs from `Planner` to `ProjectPlanner`
- evaluate whether `PlannerAgent` should become `ProjectPlannerAgent` in code
- keep mechanical rename separate from behavior changes whenever possible

Tests:

- update snapshots or string assertions only after behavior-level tests are green

Acceptance:

- user-facing terminology matches the architecture docs

## Detailed Work Items

### Work Item A: Requirement Artifact Module

Why:

- avoids scattering requirement-path logic across engine and planner code

Deliverables:

- one helper module
- one focused test file

### Work Item B: ProductManager Agent Contract

Why:

- prevents `ProductManager` from turning into a second planner that emits execution tasks

Deliverables:

- dedicated context type
- dedicated agent implementation
- dedicated fallback behavior

### Work Item C: Planner Requirement Signals

Why:

- isolates requirement lifecycle logic from generic prompt construction

Deliverables:

- minimal helper or clearly named inline logic
- tests covering missing/stale/complete states

### Work Item D: Engine Wake-Up Sequence

Why:

- this is the behaviorally risky part of the migration

Deliverables:

- explicit engine tests for PM invocation
- budget-safe sequencing
- persisted requirement artifact

### Work Item E: Completion Heuristic

Why:

- without this, ProductManager would either never refresh or refresh too often

Deliverables:

- one simple MVP heuristic
- avoid premature introduction of a structured requirement database

## Risks and Mitigations

### Risk: ProductManager becomes a second planner

Mitigation:

- keep ProductManager output Markdown-only
- forbid it from emitting round-level execution tasks

### Risk: The engine becomes too recursive in one round

Mitigation:

- allow at most one ProductManager invocation per round in the MVP
- enforce normal budget checks around the PM step

### Risk: Requirement completion becomes fuzzy

Mitigation:

- start with explicit acceptance criteria text
- require evaluator evidence to be part of the completion check

### Risk: Too much user-facing rename churn too early

Mitigation:

- finish behavior first
- do terminology cleanup last

## Test Strategy

Targeted tests should remain the default during implementation.

Recommended progression:

1. `bun test src/product/requirements.test.ts`
2. `bun test src/agent/product-manager.test.ts`
3. `bun test src/agent/planner.test.ts`
4. `bun test src/loop/engine.test.ts src/loop/engine.summary-artifact.test.ts`
5. `bun test src/loop/control.test.ts src/server.test.ts`
6. `bun test`
7. `bun run typecheck`

## Recommended Execution Order

Implement in this order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7

Do not start UI polish before the runtime PM path exists.

## Definition of Done

This initiative is complete when:

- `ProjectPlanner` and `ProductManager` both exist as working runtime concepts
- missing or exhausted product requirements trigger ProductManager artifact generation
- ProjectPlanner plans against the active requirement slice
- Executor still operates on one atomic round task
- Evaluator evidence can be used to judge requirement-slice completion
- control surfaces expose the new role/artifact model clearly
- tests and typechecks pass

## Outcome

This plan is complete. Future work should be tracked in separate plans rather than reopening this one, unless the documented ProjectPlanner/ProductManager architecture changes again.
