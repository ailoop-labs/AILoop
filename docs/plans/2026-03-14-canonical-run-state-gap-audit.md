# Canonical Run-State Gap Audit

Date: 2026-03-14
Status: Completed audit of the current persisted run-state implementation against the documented canonical run-state contract.
Artifact path: `docs/plans/2026-03-14-canonical-run-state-gap-audit.md`

## Scope

This note records the current workspace state for the persisted run-state slice. It names the live persistence entry points, cites the current documented expectation, and identifies the smallest verified gap to address next.

Source documents checked during this audit:

- `README.md`
- `ARCHITECTURE.md`
- `AILOOP_ENGINE_WORKFLOW.md`
- `.ailoop/product-requirements/current.md`

## Minimal Evidence Excerpt

Documented expectation:

- `ARCHITECTURE.md:470-490` requires file-based persistence rooted at `AILOOP_HOME` and defines `state.json` as the canonical persisted engine state.
- `.ailoop/product-requirements/current.md:34-43` requires `state.json` to expose the current goal or a goal reference alongside lifecycle state, round, budget summary, pause/error reason, and latest artifact references.

Named persistence entry points checked:

- `src/loop/state.ts:10-31` defines `AILOOP_HOME/state.json`.
- `src/loop/state.ts:147-201` reads, writes, and updates the canonical persisted state.
- `src/loop/control.ts:174-180`, `src/loop/control.ts:210-215`, and `src/loop/control.ts:243-247` persist start, stop, and resume transitions.
- `src/loop/control.ts:279-329` returns the operator-visible status payload from persisted state.

Exact verified gap:

- `src/types/contracts.ts:168-181` defines `LoopStateData` without any goal or goal-reference field.
- The live `.ailoop/state.json` snapshot also has no goal metadata.
- `src/server.ts:166-179` serves `/api/status` separately from `/api/goal`, so the canonical persisted state cannot answer the current goal question on its own.

## Documented Canonical State Contract

The current source of truth still defines `AILOOP_HOME/state.json` as the canonical persisted run-state artifact:

- `ARCHITECTURE.md:470-490` defines the required file-based persistence layout rooted at `AILOOP_HOME`, with `state.json` in the required top-level layout.
- `.ailoop/product-requirements/current.md:34-49` tightens the current requirement slice and requires:
  - `state.json` to exist as the canonical persisted run-state artifact,
  - lifecycle updates on start, round entry, success, pause, resume, stop, error, and crash recovery,
  - operator-understandable signals including current state, round, budget summary, latest transition reason, latest artifact references, and current goal or goal reference.

## Current Persistence Entry Points

The persisted run-state path and mutation surface are now concentrated in the loop state helpers and then used by control-plane and engine code:

- `src/loop/state.ts:10-31`
  - `buildLoopPaths()` defines `statePath` as `AILOOP_HOME/state.json`.
- `src/loop/state.ts:101-111`
  - `ensureLoopHome()` ensures the home layout exists and writes a default canonical `state.json` when no persisted state exists.
- `src/loop/state.ts:147-175`
  - `readLoopState()` and `writeLoopState()` are the canonical read/write helpers. They synchronize both the SQLite row and `state.json`.
- `src/loop/state.ts:195-202`
  - `updateLoopState()` is the common mutation wrapper used by higher-level flows.
- `src/loop/state.ts:267-288`
  - `recoverInterruptedLoopState()` converts interrupted lifecycle states into a persisted `paused` state for crash-recovery review.
- `src/loop/control.ts:146-180`
  - `startBackgroundLoop()` persists `starting`.
- `src/loop/control.ts:199-217`
  - `stopLoop()` persists `idle` immediately when no live engine process exists.
- `src/loop/control.ts:225-256`
  - `resumeLoop()` persists `running` for paused loops with a live PID or restarts the loop.
- `src/loop/control.ts:279-329`
  - `getLoopStatus()` reads the canonical state, applies interrupted-run recovery, and returns the operator-visible status payload.
- `src/loop/engine.ts:421-558`
  - `LoopEngine.run()` drives startup, pause, cooldown, stopping, and fatal-error state transitions.
- `src/loop/engine.ts:915-981`
  - round failure and round finalization both persist updated run state through `updateLoopState()`.
- `src/server.ts:166-179`
  - `/api/status` serves `getLoopStatus(config)`, while `/api/goal` serves the goal separately.

## Verified Current Behavior

The prior baseline gap where `state.json` was missing is no longer present.

Concrete evidence:

- `.ailoop/state.json` exists in the live workspace and currently contains the persisted lifecycle state, round, PID, last error, evaluator failure count, previous tool result, and current budget.
- `src/loop/state.ts:67-69`, `src/loop/state.ts:160-175` show explicit synchronization of `state.json` during both reads and writes.
- `bun test --timeout 30000 src/loop/state.test.ts src/loop/control.test.ts`
  - result: `33 pass`, `0 fail`
  - confirms canonical `state.json` creation/migration and control-plane status behavior.

Current live `state.json` snapshot shape:

```json
{
  "state": "running",
  "round": 0,
  "updated_at": "2026-03-14T13:27:17.090Z",
  "pid": 54096,
  "last_error": null,
  "consecutive_evaluator_failures": 0,
  "previous_tool_result": null,
  "current_budget": null
}
```

The persisted state type confirms the same current schema:

- `src/types/contracts.ts:155-168`
  - `LoopStateData` includes `state`, `round`, `updated_at`, `pid`, `last_error`, `consecutive_evaluator_failures`, `previous_tool_result`, `previous_evaluation_dimensions`, and `current_budget`.

## Smallest Verified Gap

The smallest verified remaining gap is that the canonical persisted run-state schema still has no current goal or goal-reference field.

Why this is a real documented-vs-code mismatch:

- `.ailoop/product-requirements/current.md:36-43` explicitly requires `state.json` to answer the current goal or goal reference without inspecting internal code.
- `src/types/contracts.ts:168-181` shows no goal-related field in `LoopStateData`.
- The live `.ailoop/state.json` snapshot has no goal metadata.
- `src/server.ts:166-179` exposes `/api/status` and `/api/goal` as separate endpoints, which means the operator must leave the canonical run-state artifact to recover the current goal context.

This is the smallest gap because:

- the larger file-vs-database persistence contract is already aligned enough for this slice; `state.json` now exists and is synchronized,
- lifecycle state, round, last error, and budget summary are already persisted,
- artifact references already partially flow through `previous_tool_result.artifacts` after executed rounds,
- adding a small goal reference to the canonical state is a bounded schema change that directly closes a documented operator-visible requirement.

## Next Round Recommendation

Keep the follow-up change narrow:

1. Extend `LoopStateData` with a minimal goal reference field.
2. Populate it from the existing goal source (`goal.md`) without duplicating full goal bodies unnecessarily.
3. Return the same field from `getLoopStatus()` so CLI and Web Console parity stays intact.
4. Add or update targeted tests in `src/loop/state.test.ts` and `src/loop/control.test.ts` to prove the field persists and is exposed through status.

## Audit Summary

The canonical file-based state contract has improved materially since the earlier DB-only baseline gap: `state.json` now exists and is synchronized through the main loop-state helpers. The next smallest verified mismatch is narrower and schema-level: the canonical persisted run state still does not carry the current goal or a goal reference, even though the active requirement slice requires that operator-visible signal to live in `state.json`.
