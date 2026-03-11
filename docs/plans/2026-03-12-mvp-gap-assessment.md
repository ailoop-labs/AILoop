# MVP Gap Assessment

Date: 2026-03-12

This note compares the MVP requirements in `README.md` and `ARCHITECTURE.md` against the current repository state observed on disk.

## Evidence Snapshot

Commands run during this assessment:

- `bun run ailoop` -> printed the CLI command surface (`run`, `start`, `stop`, `pause`, `resume`, `status`, `watch`, `instruct`, `history`, `roles generate`).
- `bun run typecheck` -> passed.
- `bun test --timeout 30000 src/loop/control.test.ts src/server.test.ts src/environment/workspace.test.ts` -> passed with 47 tests.
- `rg -n "instructionsPath|instructions\\.json|instructions\\.queue\\.json" src docs ARCHITECTURE.md README.md` -> confirmed the remaining persistence-layout mismatch described below.

## Requirement Mapping

| MVP requirement | Repository evidence | Status | Gap / note |
| --- | --- | --- | --- |
| Goal-based iterative loop runner engine | `src/loop/engine.ts`, `src/loop/scheduler.ts`, `src/loop/state.ts`, `src/loop/engine.test.ts`, `bun run ailoop` output | Present | The repository has a runnable loop engine, persisted state handling, and CLI control entrypoints. |
| Planner, Executor, and Evaluator contracts | `src/agent/planner.ts`, `src/agent/executor.ts`, `src/evaluation/evaluator.ts`, `src/evaluation/strategies/llm-judge.ts` | Present | Role-separated planning, execution, and judging are implemented, including multi-dimension evaluator scoring. |
| Unified tool registry for local shell, file, and HTTP tools | `src/agent/tool-registry.ts` | Present | Built-in `activate_skill`, `read_file`, `write_file`, `run_shell`, and `http_request` tools exist. The four MVP tools from `ARCHITECTURE.md` are covered. |
| Multi-dimensional budgets and pause guardrails | `src/engine/budget.ts`, `src/agent/guardrails.ts`, `src/loop/engine.budget.test.ts`, `src/loop/loop.pause-on-evaluator-failures.test.ts` | Present | Cost, time, and action budgets are modeled, and evaluator-failure pause behavior is covered by tests. |
| Web console, control API, run history, and artifact/log views | `src/server.ts`, `web/src/App.tsx`, `src/server.test.ts`, `src/loop/control.test.ts` | Present | The API exposes status, control, config, goal, run history, log tail, and per-run artifact bundle endpoints, and the UI consumes them. |
| File-based persistence and round artifacts under `.ailoop/` | `src/loop/state.ts`, `src/reporting/summary.ts`, `.ailoop/state.json`, `.ailoop/goal.md`, `.ailoop/runs/*.round.{log,summary.md,metrics.json,state_change.txt,evaluation.json}`, `src/environment/workspace.test.ts` | Present | The previously missing evaluator artifact gap is now closed; the live workspace contains canonical round artifact sets with `.round.evaluation.json`. |
| Crash recovery and rollback where supported | `src/environment/workspace.ts`, `src/loop/engine.ts`, `src/environment/workspace.test.ts`, `src/loop/control.test.ts` | Present | Snapshotting, rollback, and interrupted-process recovery are implemented and exercised by focused tests. |
| Pre-release open-source basics from `README.md` | `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug-report.yml`, `.github/ISSUE_TEMPLATE/feature-request.yml`, `ROADMAP.md` | Present | The release-adjacent docs called out in `README.md` now exist in the repository. |
| Canonical operator-instruction queue layout from `ARCHITECTURE.md` | `ARCHITECTURE.md` requires `.ailoop/instructions.queue.json`; implementation and docs still use `.ailoop/instructions.json` in `src/loop/state.ts`, `src/environment/workspace.test.ts`, `src/agent/tool-registry.ts`, `src/agent/role-definitions.ts`, `CONTRIBUTING.md`, and the live `.ailoop/` directory | Partial | This is the main remaining spec mismatch: the runtime behavior works, but the persisted filename does not match the architecture contract. |

## Missing MVP Areas

Only one concrete MVP gap remains in the current repository snapshot:

1. The architecture document still specifies `.ailoop/instructions.queue.json`, while the shipped runtime and contributor-facing docs persist operator instructions in `.ailoop/instructions.json`.

Secondary observation:

- The live `.ailoop/` directory still contains a stale legacy `.ailoop/loop.state` file alongside `.ailoop/state.json`, which suggests the persistence migration is not fully cleaned up for existing homes even though the code now reads and writes `state.json`.

## Highest-Priority Missing Capability

Complete the operator-instruction queue persistence migration so the runtime matches the canonical `ARCHITECTURE.md` layout.

Why this is next:

- `ARCHITECTURE.md` is the technical contract for the MVP persistence layout, and this is the last visible mismatch in that contract.
- The mismatch spans runtime code, contributor guidance, and live `.ailoop/` state, so it can confuse operators and future rounds about where injected instructions actually live.
- The fix is narrow and highly verifiable compared with broader feature work: rename or compatibly migrate the instruction queue file, update affected docs/tests, and confirm both fresh and pre-existing `.ailoop/` homes behave correctly.

Concrete next-round target:

- persist queued instructions at `.ailoop/instructions.queue.json`,
- add backward-compatible migration from existing `.ailoop/instructions.json`,
- update tests and contributor/role-definition references that still name `instructions.json`,
- add one regression check proving old homes self-heal without losing queued instructions.

## Assessment Summary

Compared with the earlier 2026-03-10 gap note, the repository has since closed the evaluator-artifact gap and aligned `goal.md` and `state.json` with the architecture contract. The current MVP surface is largely implemented and verifiable; the remaining high-priority work is to finish aligning the operator-instruction queue path with the documented `.ailoop/` persistence model.
