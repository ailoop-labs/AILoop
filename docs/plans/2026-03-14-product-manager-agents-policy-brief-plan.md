# ProductManager AGENTS Policy Brief Plan

## Status

Implemented

## Source-of-Truth Position

This plan refines the ProductManager handoff contract already described in:

- `README.md`
- `ARCHITECTURE.md`
- `AILOOP_ENGINE_WORKFLOW.md`
- `AGENTS.md`

It does not re-open the ProjectPlanner / ProductManager split. It only narrows how runtime product-planning context is delivered so the ProductManager reads the right sources in the right order without inheriting external coding-assistant workflows.

## Problem

The runtime `ProductManager` is now isolated from repository-root assistant pollution, but it can still inspect more repository documents than necessary before writing the active requirement artifact.

That is risky in two ways:

- broad scanning wastes budget and delays requirement generation,
- broad scanning increases the chance that implementation details or low-signal plans distort the current requirement slice.

At the same time, the handoff must not become so small that the ProductManager misses the project-level constraints defined in `AGENTS.md`.

## Goal

Make ProductManager handoffs compact, navigational, and constitution-first by:

- treating `README.md`, `ARCHITECTURE.md`, `AILOOP_ENGINE_WORKFLOW.md`, and `AGENTS.md` as the mandatory source set,
- passing `AGENTS.md` to runtime roles only through a runtime-safe policy brief,
- and making optional source expansion explicit instead of open-ended.

## Non-Goals

- adding retrieval infrastructure or embeddings,
- redesigning ProductManager output format,
- allowing runtime agents to obey external assistant skills directly,
- broad planner or evaluator prompt redesign.

## Design

### 1. Add a runtime-safe AGENTS policy brief

The engine should read `AGENTS.md` and extract only project-level principles relevant to runtime product definition, such as:

- documentation precedes code,
- documentation is the source of truth when code drifts,
- ruthless simplicity,
- Bun / TypeScript / low-dependency constraints,
- high-bandwidth UX,
- secret redaction.

It must not pass through external coding-assistant workflow mechanics such as brainstorming mandates, git behavior, or human collaboration rules.

### 2. Add a ProductManager source manifest

The ProductManager handoff should include:

- `mandatory_sources`
- `optional_sources`
- `expansion_rule`

MVP mandatory sources:

- `README.md`
- `ARCHITECTURE.md`
- `AILOOP_ENGINE_WORKFLOW.md`
- `AGENTS.md` with reason `project principles only`
- current requirement artifact, when present

MVP optional sources should stay narrow and can be empty.

### 3. Tighten the ProductManager prompt

The prompt should require:

- read mandatory sources first,
- use the runtime policy brief as the only allowed interpretation of `AGENTS.md`,
- expand only when a concrete information gap remains,
- prefer `Open Questions` over speculative repository scanning.

## Implementation Steps

### Step 1: Red Tests

- add ProductManager prompt tests for `runtime_policy_brief` and `source_manifest`
- add LoopEngine tests proving the ProductManager context includes the mandatory source set and an AGENTS-derived runtime policy brief
- add a small helper test for AGENTS policy extraction if needed

### Step 2: Add Handoff Contracts

- extend `ProductManagerContext` with `runtime_policy_brief` and `source_manifest`
- add simple contract types for source references

### Step 3: Implement Runtime-Safe AGENTS Extraction

- read `AGENTS.md` from the repository root
- extract only runtime-safe project principles

### Step 4: Wire ProductManager Handoff

- build the ProductManager source manifest inside the engine
- pass the extracted AGENTS policy brief and source manifest to the ProductManager
- update the prompt to enforce tiered reading and gap-driven expansion

### Step 5: Validate

- run targeted tests for ProductManager and LoopEngine
- run `bun test` if the targeted tests pass cleanly
- run `bun run typecheck`

## Definition of Done

- the ProductManager prompt explicitly uses a source manifest and runtime policy brief,
- the mandatory source set includes `AGENTS.md` in runtime-safe form,
- no external coding-assistant workflow from `AGENTS.md` is passed through literally,
- tests cover the new handoff contract,
- docs and plan are aligned before code changes.

## Completion Snapshot

Completed in this implementation:

- documented `AGENTS.md` as part of the mandatory ProductManager source set while preserving runtime isolation from external coding-assistant workflows,
- added compact handoff contracts for `runtime_policy_brief` and `source_manifest`,
- extracted a runtime-safe policy brief from `AGENTS.md` project principles,
- wired the LoopEngine to pass the AGENTS-derived policy brief and mandatory source manifest into ProductManager handoffs,
- updated the ProductManager prompt to enforce mandatory-first reading and gap-driven expansion,
- added regression coverage in ProductManager and LoopEngine tests.

Validation:

- `bun test src/agent/product-manager.test.ts src/loop/engine.test.ts`
- `bun test`
- `bun run typecheck`
