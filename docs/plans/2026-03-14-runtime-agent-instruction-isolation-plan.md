# Runtime Agent Instruction Isolation Plan

## Status

Implemented

## Source-of-Truth Position

This plan implements the runtime-agent isolation requirements now documented in:

- `ARCHITECTURE.md`
- `AILOOP_ENGINE_WORKFLOW.md`

It does not change the ProjectPlanner / ProductManager split. It only fixes a runtime defect where internal AILoop agents can inherit repository-local `AGENTS.md` instructions and external skill workflows intended for AI coding assistants helping humans modify the repository.

## Problem

Fresh validation on the main `3090` instance showed the runtime `ProductManager` entering an external `brainstorming` skill workflow instead of producing the requirement Markdown artifact for the active slice.

That behavior is invalid because:

- `AGENTS.md` is for external coding assistants building AILoop, not for internal runtime agents,
- runtime product-definition work must be autonomous and one-shot within the round,
- collaborative question-asking workflows can stall round execution indefinitely.

## Goal

Prevent internal runtime agent Codex sessions from silently inheriting repository-local assistant instructions, while preserving their ability to inspect repository files when needed.

## Non-Goals

- redesigning the internal agent architecture,
- changing the `ProductManager` requirement schema,
- changing the external `AGENTS.md` workflow for humans and coding assistants,
- broad executor prompt redesign.

## Design

### 1. Add isolated Codex session support

Extend `CodexClient` so a caller can request an isolated invocation context.

MVP behavior:

- run the Codex process from a scratch directory rather than the repository root,
- optionally write a small local `AGENTS.md` file into that scratch directory,
- continue to use the normal output-schema and result files,
- preserve inherited environment variables such as `CODEX_HOME`.

### 2. Add a runtime-session guide for ProductManager

The runtime `ProductManager` should provide a local session guide that says:

- this is an internal AILoop runtime agent session,
- repository-local development-assistant guides do not apply,
- external skill catalogs and collaborative brainstorming workflows must not be used,
- repository inspection must use absolute paths or an explicit `cd` into the repository root.

### 3. Pass explicit repository-root guidance in the prompt

The `ProductManager` prompt should include:

- the repository root path,
- an instruction that the Codex session is intentionally isolated from repository-local assistant guides,
- a requirement to inspect repo files using absolute paths or an explicit `cd`.

## Implementation Steps

### Step 1: Red Tests

- add a `CodexClient` test proving isolated sessions run from a scratch directory with a local `AGENTS.md`
- add a `ProductManagerAgent` test proving the runtime invocation requests isolation and includes repository-root guidance

### Step 2: Minimal Runtime Support

- add optional session-isolation options to `CodexJsonCallOptions`
- implement scratch-dir invocation behavior in `CodexClient`

### Step 3: Apply to ProductManager

- switch `ProductManagerAgent` to isolated runtime sessions
- update the prompt with repository-root guidance

### Step 4: Validate

- run targeted tests for `codex-client` and `product-manager`
- run full `bun test`
- run `bun run typecheck`
- restart the clean `3090` validation loop and confirm the requirement artifact is produced

## Definition of Done

- runtime `ProductManager` no longer inherits repository-local assistant/skill workflows,
- a clean validation run on `3090` proves the runtime `ProductManager` is running in an isolated session and is no longer invoking external development-assistant workflows,
- tests cover the isolation contract,
- the implementation is documented and committed.

## Completion Snapshot

Completed in this implementation:

- documented runtime-agent instruction isolation as an architectural and workflow requirement,
- added isolated Codex session support to `CodexClient`,
- switched `ProductManagerAgent` to an isolated runtime session with a local runtime-only `AGENTS.md` guide,
- added repository-root guidance to the `ProductManager` prompt,
- added regression tests for both the Codex session isolation contract and the ProductManager runtime invocation,
- passed `bun test`,
- passed `bun run typecheck`.

Runtime verification outcome on the clean `3090` loop:

- `ProjectPlanner` reached the `ProductManager` stage normally,
- `ProductManager` ran from an isolated scratch session directory instead of the repository root,
- the runtime log no longer showed the external `brainstorming` skill workflow,
- the runtime log showed repository inspection through explicit absolute paths.

Residual observation:

- the runtime `ProductManager` still scans more repository documents than necessary before writing the requirement artifact,
- this is a follow-up prompt/efficiency issue, not the original instruction-pollution defect.
