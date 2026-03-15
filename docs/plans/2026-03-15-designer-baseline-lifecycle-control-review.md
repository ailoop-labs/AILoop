# Designer Baseline Clarification: Single-Run Lifecycle Control and Budget Pause Safety

## objective

Establish the current UI/observability baseline for the active requirement slice before any console mutation work, using the canonical docs plus the live workspace state.

## workspace snapshot and diff summary

- `git status --short` is clean.
- Canonical requirement slice exists at `.ailoop/product-requirements/current.md`.
- Live persisted state in `.ailoop/state.json` currently shows `state=running`, `round=0`, `pid=76926`, `last_error=null`, and `current_budget=null`.
- Relevant implementation surfaces for this slice are:
  - `web/src/App.tsx`
  - `web/src/run-history.ts`
  - `web/src/requirement-snapshot.tsx`
  - `src/loop/control.ts`
  - `src/server.ts`
  - `src/types/contracts.ts`

## compact artifact manifest

- Present under `.ailoop/`:
  - `state.json`
  - `loop.lock`
  - `goal.md`
  - `instructions.queue.json`
  - `runs/2026-03-15T01-49-21-350Z.round.log`
- Missing for the active run timestamp `2026-03-15T01-49-21-350Z`:
  - `.round.summary.md`
  - `.round.metrics.json`
  - `.round.state_change.txt`
  - `.round.evaluation.json`
- Current console artifact retrieval is strict: `src/loop/control.ts` returns `null` from `getRunArtifacts()` unless the full five-file bundle exists, so an interrupted or in-flight round with only partial evidence is not directly reviewable from the artifact modal.

## user-facing problem

The current console already exposes state, controls, crash recovery, budgets, requirement snapshot, logs, and completed run history, but the operator still lacks a compact live answer to two governance questions:

1. Why is the run paused or unsafe right now?
2. How complete is the current round's evidence bundle right now?

Today those answers are fragmented across `status.state`, `status.last_error`, `status.crash_recovery`, the budget panel, and the run-history modal. That is workable for completed rounds, but weak for partial, interrupted, or budget-paused rounds where the operator needs a fast go/no-go read.

## proposed layout and interaction changes

### 1. Promote a single status rail at the top of the dashboard

Add one compact operator rail directly under the state chip with three persistent blocks:

- `Lifecycle`
  - current canonical state
  - round number
  - process liveness
- `Pause / Risk Reason`
  - explicit label such as `manual pause`, `budget breach`, `evaluator threshold`, `crash recovery`, `rollback incomplete`, or `engine error`
  - one-line recovery instruction
- `Artifact Completeness`
  - `log only`, `partial bundle`, or `full bundle`
  - latest artifact timestamp

### 2. Treat budget health as a review surface, not only a meter

Keep the existing bars, but add per-dimension outcome labels:

- `healthy`
- `warning`
- `breached`

When paused from a budget event, freeze and retain the last known budget snapshot instead of collapsing to a blank "No budget usage yet" state.

### 3. Show incomplete artifact bundles in run history

Keep the current completed-round detail modal, but add an intermediate card state for interrupted runs:

- `Incomplete evidence`
- show which artifacts exist
- allow opening available artifacts without requiring the full bundle
- visually separate `reviewable partial round` from `completed evaluated round`

### 4. Keep the current strengths

Preserve the existing pieces that already align with the requirement slice:

- prominent lifecycle chip
- dedicated crash recovery panel
- requirement snapshot card
- compact role runtime timeline
- structured evidence cards in the run-detail modal

## high-bandwidth UX rationale

- A dedicated `Pause / Risk Reason` block converts raw `last_error` text into an operator-classified decision signal.
- An `Artifact Completeness` block makes observability parity legible for in-flight and interrupted rounds without forcing a modal drill-down.
- Preserving the last budget snapshot during paused states keeps the causal chain visible. The operator should not have to infer whether the run paused before budget collection or because budget collection disappeared.
- Partial-bundle visibility improves timeline readability: the operator can distinguish `execution started`, `execution interrupted`, and `evaluation completed` as separate review states instead of a binary present/missing history.

## accessibility and responsive considerations

- Do not rely on color alone for pause reasons or budget severity. Pair each color with explicit text labels.
- Keep the top status rail stackable to one column on mobile, then expand to three columns on tablet and desktop.
- Use concise labels that survive narrow widths without truncating the main safety meaning.
- Maintain keyboard access to any partial-artifact drawers or modals.
- If incomplete artifacts are shown in cards, expose the exact missing artifact names in text so screen-reader users get the same completeness signal.

## acceptance checks

- `GET /api/status` (or its successor payload) exposes a structured operator-facing pause/risk reason rather than relying only on freeform `last_error`.
- The console header shows state, pause/risk reason, and artifact completeness in one glance without opening a modal.
- A budget-paused run still shows the last recorded budget snapshot and the breached dimension.
- A run with only `.round.log` is rendered as an incomplete but reviewable round instead of disappearing from artifact review.
- Completed rounds continue to open the existing full artifact detail experience.
- On small screens, the status rail, controls, and budget surface stack without horizontal scrolling.

## alignment check

### documented alignment already present

- `web/src/App.tsx` already gives current lifecycle prominence through the state chip and top control area.
- `web/src/App.tsx` already surfaces crash recovery as a dedicated panel instead of burying it in logs.
- `web/src/App.tsx` and `web/src/run-history.ts` already prefer structured evidence cards over raw markdown-only review for completed rounds.

### verified gaps against the active requirement slice

- The console does not currently expose a structured pause-reason taxonomy for non-crash pauses; it mainly falls back to `last_error`.
- The live dashboard does not show artifact completeness for the current round.
- `src/loop/control.ts` hides partial bundles from `getRunArtifacts()`, which weakens reviewability for interrupted rounds.
- The budget panel loses context when `current_budget` is absent, even if the operator still needs the last known bounded-state evidence.

## open questions

None. The next round can safely implement the smallest status-surface change without further product clarification.
