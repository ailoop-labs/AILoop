# MVP Gap Assessment

Date: 2026-03-10

This note compares the MVP requirements in `README.md` and `ARCHITECTURE.md` against the repository state observed on disk.

## Requirement Mapping

| MVP requirement | Repository evidence | Status | Gap / note |
| --- | --- | --- | --- |
| Goal-based iterative loop runner engine | `src/loop/engine.ts`, `src/loop/state.ts`, `src/loop/scheduler.ts`, `src/loop/engine.test.ts` | Present | Core loop orchestration and state machine are implemented in code and covered by focused tests. |
| Planner, Executor, and Evaluator contracts | `src/agent/planner.ts`, `src/agent/executor.ts`, `src/evaluation/evaluator.ts`, `src/evaluation/strategies/*` | Present | Role-separated planning, execution, and evaluation layers exist. |
| Unified tool registry for local shell, file, and HTTP tools | `src/agent/tool-registry.ts` | Present | Built-in `read_file`, `write_file`, `run_shell`, `http_request`, and skill activation are implemented. |
| Multi-dimensional resource budgets and guardrails | `src/engine/budget.ts`, `src/agent/guardrails.ts`, `src/loop/engine.budget.test.ts`, `src/loop/loop.pause-on-evaluator-failures.test.ts` | Present | Cost, time, and action budgets are modeled and pause behavior is tested. |
| CLI control plane (`start`, `pause`, `resume`, `stop`, `status`, `instruct`) | `scripts/ailoop.ts`, `src/loop/control.ts` | Present | CLI commands and supporting control helpers exist. |
| Web console, API, status, controls, run history, and log viewing | `src/server.ts`, `web/src/App.tsx`, `web/src/log-follow.ts`, `web/src/run-history-pagination.ts` | Present | Console server and React UI are present with matching control and history/log surfaces. |
| File-based persistence under `AILOOP_HOME` | `src/loop/state.ts`, `src/reporting/summary.ts`, current `.ailoop/` contents | Partial | Persistence exists, but the on-disk contract does not fully match the architecture document. |
| Required round artifact set includes evaluator result | `ARCHITECTURE.md` requires `*.round.evaluation.json`; `src/reporting/summary.ts` only builds `.round.log`, `.round.summary.md`, `.round.metrics.json`, `.round.state_change.txt`; current `.ailoop/runs/` files also lack `*.round.evaluation.json` | Missing | Evaluator decisions are not persisted as their own canonical artifact. |
| Architecture-required root persistence names (`state.json`, `goal.md`, `instructions.queue.json`) | `ARCHITECTURE.md` documents those names; implementation uses `.ailoop/loop.state`, `.ailoop/task.md`, `.ailoop/instructions.json` in `src/loop/state.ts` and current `.ailoop/` | Partial | The system persists equivalent data, but the filenames diverge from the documented contract. |
| Pre-release open-source docs (`CONTRIBUTING.md`, issue templates, roadmap/limitations`) | Repository root and `.github/` contents observed via file listing | Missing (non-MVP release work) | These are listed in `README.md` as before-release tasks, not core MVP runtime blockers. |

## Highest-Priority Missing MVP Component

`*.round.evaluation.json` persistence is the single highest-priority missing component.

Why this is first:
- `ARCHITECTURE.md` defines evaluator output as a first-class artifact in the required `.ailoop/runs/` layout.
- Transparent history and reviewable evidence are core product promises in `README.md`.
- The engine already produces other round artifacts, so the missing evaluator artifact is a narrow, verifiable gap with high audit value.

Concrete evidence:
- `src/reporting/summary.ts` exposes `buildRoundArtifactPaths()` without an evaluation artifact path.
- A repository search for `evaluation.json` in `src/`, `scripts/`, and `web/` returns no implementation writer.
- Existing files under `.ailoop/runs/` contain logs, summaries, metrics, and state-change files, but no `*.round.evaluation.json`.

## Recommended Next Round Target

Implement canonical evaluator artifact persistence for each round:
- extend round artifact path generation to include `*.round.evaluation.json`,
- write evaluator decision, justification, evidence, and recommended next action after evaluation,
- add a focused test proving the file is emitted for a passing and failing round,
- optionally decide in the same change whether to align the documented root filenames or update the architecture doc to match the shipped names.
