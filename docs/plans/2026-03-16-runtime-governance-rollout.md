# Runtime Governance Rollout

## Intent

Convert the current discussion into a sequence of AILoop-friendly work items that improve runtime efficiency, control code growth, and prepare a small external validation path without weakening quality.

This rollout is ordered. AILoop should execute one slice at a time and should not mix these items into the already completed Web Console `History` review slice.

## Why This Order

1. Runtime context governance comes first because it reduces token waste and prompt contamination risk across all later work.
2. Structural maintenance governance comes second because it prevents continued hot-file growth while preserving small-step execution.
3. External-project validation comes last because it should test the improved engine, not the current noisier version.

## Phase 1: Runtime Context Governance

### Goal
Reduce token bloat and runtime instruction contamination for internal agents while preserving result quality.

### Target Outcome
- Internal runtime agents stop inheriting repository-local external-assistant workflows unless explicitly distilled by the engine.
- Planner, Executor, Evaluator, Designer, and Leader use isolated runtime sessions similar to ProductManager.
- Runtime prompts become smaller and more navigational without removing critical governance constraints.

### Slices

#### Slice 1.1
- Refresh the active requirement away from the completed Web Console UI work and define a requirement slice for runtime context governance.

#### Slice 1.2
- Add runtime session isolation for Planner, Executor, Evaluator, Designer, and Leader using the existing ProductManager isolation pattern.
- Add or update focused tests proving the isolation guide is passed to Codex for those roles.

#### Slice 1.3
- Add prompt-budget controls for runtime roles.
- Prefer compact manifests, summaries, and targeted excerpts over large raw context bodies.
- Add tests for truncation or summarization behavior where deterministic.

#### Slice 1.4
- Add evaluator evidence-budget controls so large logs and state-change artifacts are summarized first and only expanded when needed.
- Preserve on-disk artifacts and reviewability.

## Phase 2: Structural Maintenance Governance

### Goal
Prevent endless growth of hot files while preserving the MVP rule of small, bounded rounds.

### Target Outcome
- The system can explicitly choose a small structural-maintenance round when code growth becomes unhealthy.
- Hot-file pressure becomes visible to Planner, Evaluator, and Leader.

### Slices

#### Slice 2.1
- Define a simple hot-file heuristic.
- Recommended starting thresholds:
  - warning at 600 lines
  - refactor candidate at 800 lines
  - hot file when touched in 3 of the last 5 rounds

#### Slice 2.2
- Teach Planner to emit bounded structural-maintenance subtasks when hot-file thresholds are met.
- Limit scope to non-behavioral extraction, module splits, naming cleanup, and test-preserving reorganization.

#### Slice 2.3
- Teach Evaluator to treat unnecessary continued growth of a hot file as a governance risk signal rather than only a cosmetic concern.
- Add tests covering pass and fail cases.

#### Slice 2.4
- Teach Leader telemetry or friction reporting to surface hot-file pressure in pause diagnostics.

## Phase 3: External Validation Path

### Goal
Prove AILoop can work on a second repository without relying on self-iteration familiarity.

### Target Outcome
- A small pilot workflow exists for trying AILoop on another project with bounded risk.
- Success criteria are measurable and comparable to self-iteration results.

### Slices

#### Slice 3.1
- Define the pilot-repo selection criteria and a lightweight runbook.
- Prefer a small TypeScript repository with existing tests and low operational risk.

#### Slice 3.2
- Add a verification checklist for external-project runs.
- Track at least:
  - rounds per successful task
  - human interventions per task
  - token or cost per round if available
  - evaluator infrastructure failures
  - hot-file growth during the pilot

#### Slice 3.3
- Document a narrow first pilot scope:
  - one bugfix
  - one small feature
  - one structural-maintenance task

## Recommended Operator Instructions

Queue these one at a time, not all at once.

### Instruction A
Switch the active requirement slice away from the completed Web Console `History` review work. Refresh `.ailoop/product-requirements/current.md` for a runtime-context-governance slice whose first implementation target is adding session isolation for Planner, Executor, Evaluator, Designer, and Leader, following the existing ProductManager pattern, with focused tests.

### Instruction B
After runtime session isolation passes, define and implement prompt-budget and evidence-budget controls so runtime roles receive compact manifests and targeted excerpts by default instead of broad raw context.

### Instruction C
After prompt-budget work passes, define and implement hot-file governance so Planner, Evaluator, and Leader can detect oversized frequently touched files and schedule bounded structural-maintenance rounds.

### Instruction D
After governance work passes, define a small external-project pilot requirement slice and supporting checklist for validating AILoop on a second repository with bounded risk.

## Non-Goals

- Do not mix this rollout into the completed Web Console `History` semantic diff slice.
- Do not attempt a big-bang refactor of `src/loop/engine.ts`, `src/loop/control.ts`, or `src/evaluation/strategies/llm-judge.ts` in one round.
- Do not start with a multi-project platform or marketplace design.
- Do not lower result quality just to reduce prompt size.
