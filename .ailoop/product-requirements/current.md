# Executor Operational Evidence Contract Alignment

## Problem
The previous active requirement slice is complete, so it cannot guide the next atomic round. The runtime now requires executor results to include compact operational evidence, but `ARCHITECTURE.md` still documents an older `ToolResult` shape that omits that field and the supporting contract language. The next slice must refresh the requirement artifact first so documentation remains the source of truth before any implementation or follow-up doc edits continue.

## Current Objective
Define one documentation-first requirement slice that aligns the documented Executor contract with the runtime expectation for `operational_evidence`, while keeping `README.md` unchanged unless this refresh proves a constitutional gap.

## User Value
Operators, reviewers, and future agents get one precise source of truth for the next round. The refreshed slice removes ambiguity about whether executor outputs must carry direct verification proof, and it gives the CCB exact wording to review before any README or architecture edit is attempted.

## In Scope
- Refresh `.ailoop/product-requirements/current.md` as the active requirement artifact.
- Define the next atomic documentation slice as Executor contract alignment for `operational_evidence`.
- Provide exact proposed wording for any required `README.md` or `ARCHITECTURE.md` change.
- Make rerunnable verification steps explicit.
- State explicit boundaries so the next round does not drift into implementation work or unrelated architecture cleanup.

## Acceptance Criteria
- The active requirement names Executor operational-evidence contract alignment as the current objective.
- The requirement includes exact proposed wording or diff-ready text for `ARCHITECTURE.md`.
- The requirement explicitly states whether `README.md` changes are required for this slice.
- The requirement includes rerunnable verification steps that confirm the required sections exist in `.ailoop/product-requirements/current.md`.
- The requirement includes an `Out of Scope` section that excludes code changes, UI work, and speculative contract expansion.
- Every referenced document path in this artifact exists in the workspace.

## Proposed Documentation Changes

### `README.md`
No README change is required for this slice.

Exact rationale for reviewers:

> Keep `README.md` unchanged. The existing `Transparent History` principle already requires raw evidence to remain reviewable while agent-facing handoffs stay summary-first and excerpt-driven, so this slice only needs an architecture-contract update.

### `ARCHITECTURE.md`
Replace the `ToolResult` block and requirement bullets in `## 8.3 Executor Contract` with the following diff-ready text:

````md
### 8.3 Executor Contract

```ts
type ToolResult = {
  status: "success" | "failure";
  summary: string;
  error?: {
    type: string;
    message: string;
    stack?: string;
  };
  artifacts: {
    log_path: string;
    state_change_path: string;
    bundle_path?: string;
  };
  next_state_hint?: "continue" | "pause" | "stop";
  operational_evidence?: string[];
};
```

Requirements:

- success only when the sub-task is verified,
- failure includes a concrete blocker,
- executor responses include compact `operational_evidence` whenever verification commands or checks are run, using direct command output excerpts and key implementation excerpts as proof,
- logs, artifacts, and operational evidence redact secrets before persistence,
- next-state hint is advisory to the engine.
````

## Verification Steps
1. Re-open `.ailoop/product-requirements/current.md` and confirm it contains these headings:
   - `## Current Objective`
   - `## Acceptance Criteria`
   - `## Proposed Documentation Changes`
   - `## Verification Steps`
   - `## Out of Scope`
2. Verify the referenced documentation paths exist:
   - `/Users/yinjames/projects/AILoop/README.md`
   - `/Users/yinjames/projects/AILoop/ARCHITECTURE.md`
3. Confirm the proposed `ARCHITECTURE.md` wording includes `operational_evidence` and the secret-redaction requirement.

Suggested rerunnable commands:

```sh
rg -n "^## (Current Objective|Acceptance Criteria|Proposed Documentation Changes|Verification Steps|Out of Scope)$" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
test -f /Users/yinjames/projects/AILoop/README.md && test -f /Users/yinjames/projects/AILoop/ARCHITECTURE.md && echo "doc paths verified"
rg -n "operational_evidence|redact secrets before persistence" /Users/yinjames/projects/AILoop/.ailoop/product-requirements/current.md
```

## Out of Scope
- Editing `README.md` or `ARCHITECTURE.md` in this round
- Any source-code change under `src/` or `web/`
- Web Console UI changes
- Executor prompt or schema changes
- New evidence formats beyond the documented `operational_evidence` field
- Broader architecture-contract cleanup outside `## 8.3 Executor Contract`
- Edge-case handling not required to define this requirement slice

## Open Questions
- Should the eventual `ARCHITECTURE.md` update also document `bundle_path`, or should that remain an implementation detail outside the contract narrative?
- Should the executor contract say `operational_evidence` is required on every response, or only when verification commands actually run?

## Lifecycle Status
- Status: drafted
- Completed In Round: pending
- Completion Reason: pending implementation of the documentation slice above
