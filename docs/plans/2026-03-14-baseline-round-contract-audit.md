# Baseline MVP Round Contract Audit

Date: 2026-03-14
Status: Completed audit of the current workspace against the baseline round contract in `README.md` and `ARCHITECTURE.md`.

## Follow-on Status Update

The original missing-`state.json` gap captured below is no longer the current repository state. A follow-on audit at `docs/plans/2026-03-14-canonical-run-state-gap-audit.md` rechecked the canonical persisted run-state slice after the later state-sync work landed.

Minimal evidence excerpt from that follow-on audit:

- Documented contract: `ARCHITECTURE.md:470-490` and `.ailoop/product-requirements/current.md:34-43` still require `AILOOP_HOME/state.json` to be the canonical persisted run state and to expose the current goal or a goal reference.
- Persistence entry points now present: `src/loop/state.ts:10-31` and `src/loop/state.ts:147-201` define and synchronize `state.json`; `src/loop/control.ts:174-180`, `src/loop/control.ts:210-215`, `src/loop/control.ts:243-247`, and `src/loop/control.ts:279-329` persist lifecycle transitions and return operator-visible status from that state.
- Verified remaining gap: `src/types/contracts.ts:168-181` and the live `.ailoop/state.json` snapshot still omit goal metadata, while `src/server.ts:166-179` keeps `/api/status` and `/api/goal` separate.

## Scope

This audit checks the current repository against the baseline MVP round contract captured in:

- `README.md`
- `ARCHITECTURE.md`
- `AILOOP_ENGINE_WORKFLOW.md`
- `docs/plans/2026-03-14-baseline-round-requirements.md`

This note does not redefine requirements. It records what is implemented now and identifies the smallest verified implementation gap to address next.

## Evidence Snapshot

Commands run during this audit:

- `bun run ailoop`
  - printed the CLI command surface: `run`, `start`, `stop`, `pause`, `resume`, `status`, `watch`, `instruct`, `history`, `roles generate`
- `bun test --timeout 30000 src/loop/state.test.ts src/reporting/summary.test.ts`
  - passed with `18 pass`, `0 fail`
- `test -f .ailoop/state.json && echo state_json_present || echo state_json_missing`
  - returned `state_json_missing`
- `ls -la .ailoop`
  - showed `goal.md`, `instructions.queue.json`, `loop.lock`, `ailoop.db`, and round artifacts, but no `state.json`

## Primary Evidence

Relevant source-of-truth excerpts:

```text
ARCHITECTURE.md:411-431
The MVP uses file-based persistence rooted at `AILOOP_HOME`, defaulting to `.ailoop/` in the workspace.

.ailoop/
  state.json
  loop.lock
  goal.md
  instructions.queue.json
  runs/
    <timestamp>.round.log
    <timestamp>.round.summary.md
    <timestamp>.round.metrics.json
    <timestamp>.round.state_change.txt
    <timestamp>.round.evaluation.json

- `state.json`: canonical persisted engine state, active run metadata, and counters.
```

```text
docs/plans/2026-03-14-baseline-round-requirements.md:91-110
Required persistence layout under `AILOOP_HOME`:

.ailoop/
  state.json
  loop.lock
  goal.md
  instructions.queue.json
  runs/
    <timestamp>.round.log
    <timestamp>.round.summary.md
    <timestamp>.round.metrics.json
    <timestamp>.round.state_change.txt
    <timestamp>.round.evaluation.json

- `state.json`: canonical persisted engine state and counters
```

Relevant implementation excerpts:

```text
src/loop/state.ts:25
statePath: path.join(homeDir, "state.json"), // Maintained for transition/compat but not authoritative

src/loop/state.ts:67-93
migrateLegacyLoopState()
- bootstraps SQLite from `state.json` when needed
- deletes `state.json` after DB bootstrap succeeds

src/loop/state.ts:139-155
readLoopState() reads from `ailoop.db`
writeLoopState() writes to `ailoop.db`
```

```text
src/server.ts:69-80
const dbPath = path.join(config.homeDir, "ailoop.db");
db: new DatabaseManager({ dbPath })
```

Raw stdout for the filesystem checks cited above:

Command:

```sh
test -f .ailoop/state.json && echo state_json_present || echo state_json_missing
```

Stdout:

```text
state_json_missing
```

Command:

```sh
ls -la .ailoop
```

Stdout:

```text
total 216
drwxr-xr-x@ 26 yinjames  staff    832 Mar 14 18:08 .
drwxr-xr-x@ 24 yinjames  staff    768 Mar 14 17:54 ..
-rw-r--r--@  1 yinjames  staff     65 Mar 14 18:05 .roles_source_hash
-rw-r--r--@  1 yinjames  staff   4052 Mar 14 16:11 DESIGNER_ROLE.md
-rw-r--r--@  1 yinjames  staff   3962 Mar 14 16:11 EVALUATOR_ROLE.md
-rw-r--r--@  1 yinjames  staff   3876 Mar 14 16:11 EXECUTOR_ROLE.md
-rw-r--r--@  1 yinjames  staff   3421 Mar 14 16:11 LEADER_ROLE.md
-rw-r--r--@  1 yinjames  staff   3452 Mar 14 16:11 PLANNER_ROLE.md
-rw-r--r--@  1 yinjames  staff   3065 Mar 14 16:11 PRODUCT_MANAGER_ROLE.md
-rw-r--r--@  1 yinjames  staff   2801 Mar 14 16:11 PRODUCT_OWNER_ROLE.md
-rw-r--r--@  1 yinjames  staff   2706 Mar 14 16:11 QA_LEAD_ROLE.md
-rw-r--r--@  1 yinjames  staff   2600 Mar 14 16:11 SENIOR_DEV_ROLE.md
-rw-r--r--@  1 yinjames  staff  32768 Mar 14 18:05 ailoop.db
drwxr-xr-x@  8 yinjames  staff    256 Mar 12 13:55 codex-home
-rw-------@  1 yinjames  staff     60 Mar 14 18:05 console.admin.token.cache
drwxr-xr-x@  3 yinjames  staff     96 Mar 14 16:05 context
-rw-r--r--@  1 yinjames  staff     20 Mar 11 22:48 goal.md
-rw-r--r--@  1 yinjames  staff      3 Mar 14 18:07 instructions.queue.json
-rw-r--r--@  1 yinjames  staff      6 Mar 14 18:05 loop.lock
-rw-r--r--@  1 yinjames  staff      6 Mar 14 18:05 loop.pid
-rw-r--r--@  1 yinjames  staff     53 Mar 14 18:05 prod.server.log
-rw-r--r--@  1 yinjames  staff      6 Mar 14 18:05 prod.server.pid
drwxr-xr-x@  3 yinjames  staff     96 Mar 14 18:08 product-requirements
drwxr-xr-x@  4 yinjames  staff    128 Mar 14 18:19 runs
-rw-r--r--@  1 yinjames  staff    755 Mar 11 08:24 runtime-config.json
-rw-r--r--@  1 yinjames  staff     18 Mar 11 09:42 task.md
```

## Requirement Mapping

| Baseline requirement area | Repository evidence | Status | Note |
| --- | --- | --- | --- |
| One atomic round lifecycle with planner -> executor -> evaluator flow | `src/loop/engine.ts`; `src/agent/planner.ts`; `src/agent/executor.ts`; `src/evaluation/evaluator.ts` | Present | The core round loop and role-separated contracts exist in code. |
| Human control surface for `start`, `pause`, `resume`, `stop`, `status`, `instruct` | `src/loop/control.ts`; `src/server.ts`; `bun run ailoop` output | Present | The command surface and control/API entrypoints are implemented. |
| Canonical instruction queue path `.ailoop/instructions.queue.json` | `src/loop/state.ts:23-24`; `src/loop/state.test.ts`; `.ailoop/instructions.queue.json` | Present | The prior queue filename mismatch has been resolved. |
| Required round artifact bundle including evaluation output | `src/reporting/summary.ts`; `src/loop/control.ts:411-429`; `.ailoop/runs/*.round.{log,summary.md,metrics.json,state_change.txt,evaluation.json}` | Present | Required artifact paths and evaluation artifact loading are implemented. |
| Canonical file-based persisted run state at `.ailoop/state.json` | `ARCHITECTURE.md:411-439`; `docs/plans/2026-03-14-baseline-round-requirements.md:95-112`; `src/loop/state.ts:25,67-93,139-155`; `src/utils/db.ts:1-175`; `src/server.ts:69-81`; live `.ailoop/` listing | Missing | The docs require `state.json` as canonical persisted engine state, but the runtime now reads and writes SQLite state in `ailoop.db` and deletes `state.json` after bootstrap. |

## Smallest Verified Implementation Gap

The smallest verified baseline gap is the persisted run-state contract:

- The source-of-truth docs still require file-based canonical state at `.ailoop/state.json`.
- The runtime does not keep that file as the source of truth.
- `src/loop/state.ts` explicitly marks `state.json` as "not authoritative", reads state from `ailoop.db`, and removes `state.json` once DB bootstrap succeeds.
- `src/server.ts` also initializes its console runtime directly from `.ailoop/ailoop.db`.
- The live workspace confirms the mismatch: `.ailoop/` contains `ailoop.db` but no `state.json`.

This is a real implementation gap, not just a stale note:

- `ARCHITECTURE.md:411-439` defines `state.json` as required and canonical.
- `docs/plans/2026-03-14-baseline-round-requirements.md:95-112` repeats that requirement for the baseline MVP slice.
- The current code and runtime violate that contract.

## Why This Gap Should Be Addressed Next

This is the narrowest next fix with direct contract value:

1. It is a documented source-of-truth mismatch in the root persistence model.
2. It affects operator-visible recoverability and audit semantics because the architecture still promises file-based canonical state.
3. It is smaller and more verifiable than broader governance or UI work.

The follow-up implementation should pick one of two contract-alignment directions:

- restore dual-write or file-authoritative persistence so `.ailoop/state.json` exists and remains canonical, or
- explicitly update the source-of-truth architecture documents if SQLite is now the intended canonical state model.

Under current precedence, the safer next round is to align the code to the existing docs rather than assume the docs should change.

## Audit Summary

The workspace substantially implements the baseline MVP round contract: the round loop, control-plane commands, instruction queue naming, and round artifact set are all present and test-backed. The smallest remaining verified gap is that canonical persisted run state is documented as `.ailoop/state.json`, while the shipped runtime is SQLite-backed and the live workspace has no `state.json`.
