# Evaluator Compact Handoff and Infrastructure Failure Plan

## Status

Implemented

## Purpose

This document narrows a specific reliability problem discovered during live loop validation:

- evaluator prompts are receiving oversized raw evidence bodies
- engine-managed artifacts are leaking back into `state_change` in a recursive way
- `Codex exited with code 1` is being surfaced too generically, which hides whether the failure came from evaluator infrastructure or ordinary round evidence quality

The goal of this plan is to restore a compact, navigational handoff model between roles while improving failure diagnosis.

## Problem Statement

Observed validation behavior showed:

- an execution round could complete meaningful work
- evaluator dimensions could still all fail with `Codex exited with code 1`
- the resulting summary could misleadingly report the round as if the Executor simply failed, even though the first execution pass had already produced a useful artifact

The most likely immediate causes are:

- `state_change` includes `.ailoop/runs/*.round.log` growth, which makes the evaluator payload far too large
- evaluator prompts inline full raw `tool_result` and `state_change` bodies instead of a compact evidence brief
- generic Codex exit handling hides the underlying evaluator infrastructure clue
- rework handoffs replay too much raw content instead of passing issue-oriented navigation

## Target Outcome

After this change:

- evaluator prompts receive compact evidence briefs
- large raw artifacts remain on disk and are referenced by path
- state-change artifacts focus on intentional workspace mutations rather than recursive observability output
- evaluator infrastructure failures are surfaced distinctly from ordinary evidence failures
- round summaries no longer collapse the first useful execution signal behind later rework noise without leaving a compact record of what actually happened

## Completion Snapshot

Implemented in this slice:

- evaluator prompts now use compact evidence briefs instead of embedding full raw `state_change`
- evaluator infrastructure failures now classify generic Codex process exits separately from ordinary evidence insufficiency
- workspace state-change generation excludes recursive `.ailoop/runs/*` file diffs
- evaluator-to-executor rework instructions now use compact navigational guidance plus artifact references
- round summaries preserve the first successful execution signal when later rework/governance execution fails
- SQLite connections now use a busy timeout so control-plane polling is less likely to fail with `SQLITE_BUSY` during background loop activity

Verification completed with:

- targeted red-green tests for evaluator prompt compactness, infrastructure classification, workspace diff filtering, rework handoff compactness, and summary preservation
- full `bun test`
- `bun run typecheck`

## Scope

### In Scope

- compact evaluator handoff construction
- exclusion of engine-managed run artifacts from snapshot diff noise
- improved evaluator infrastructure failure classification
- tighter rework instructions that reference issues and artifact paths instead of full raw state dumps
- tests that prove prompt compactness and failure classification

### Out Of Scope

- redesigning the full governance model
- adding read-write tool access to the evaluator
- replacing the current artifact store layout
- changing the ProjectPlanner/ProductManager split that was already implemented

## Implementation Principles

- documentation first
- smallest change that removes prompt bloat
- preserve reviewable raw artifacts on disk
- do not remove evidence, only change what is inlined into downstream prompts
- keep evaluator tool access unchanged for this slice

## Delivery Sequence

### Phase 1: Define Compact Handoff Helpers

Goal:

- create a reusable compact evidence brief instead of handing full raw state into evaluation

Changes:

- add a helper that summarizes state change into changed files, line counts, and small notes
- add a helper that constructs an artifact manifest from canonical round artifact paths
- add a helper that trims recent logs to a small, targeted tail

Acceptance:

- evaluator prompt construction can depend on the brief rather than raw artifact bodies

### Phase 2: Stop Recursive Run-Artifact Diff Expansion

Goal:

- prevent `.ailoop/runs/*` files from dominating workspace state-change artifacts

Changes:

- exclude engine-managed run artifacts from snapshot file diff generation
- preserve git delta sections and concise mutation summaries for actual workspace changes

Acceptance:

- `*.round.state_change.txt` no longer embeds giant `.round.log` diffs for the same round

### Phase 3: Improve Evaluator Prompt and Failure Classification

Goal:

- keep evaluator input small and diagnose evaluator-side Codex failures clearly

Changes:

- update `buildDimensionPrompt()` to use a compact evidence brief
- include artifact paths and targeted hints instead of full raw `state_change`
- preserve stderr details when Codex evaluation fails
- classify evaluator failures as infrastructure when evidence points to auth, tooling, transport, or prompt-construction issues

Acceptance:

- evaluator failure output contains actionable infrastructure guidance when appropriate
- evaluator prompt is materially smaller than the old raw-body form

### Phase 4: Tighten Rework Handoffs

Goal:

- stop feeding the Executor huge raw evaluator context during tactical rework

Changes:

- replace `Current Modified Content` raw dump with compact issue-focused instructions
- include only blocking dimensions, recommended next action, and artifact references

Acceptance:

- rework instructions stay concise and issue-specific

### Phase 5: Summary and Validation Alignment

Goal:

- keep the round summary honest about what succeeded first and what failed later

Changes:

- ensure summary/reporting uses the final evaluation result while retaining compact evidence that the first execution pass completed useful work when applicable
- verify the previous-tool-result path still reflects final engine state without erasing earlier round evidence from artifacts

Acceptance:

- a reviewer can tell whether the first execution succeeded even if later rework or governance failed

## Test Strategy

Add or update tests for:

- workspace state-change generation excluding `.ailoop/runs/*` recursive diffs
- evaluator prompt content using compact summaries instead of full raw state change
- evaluator infrastructure failure classification when stderr contains clear clues
- rework instruction generation using issue-focused navigation instead of full raw dump
- end-to-end round behavior for the failed validation scenario shape

The implementation must follow TDD:

- write the failing tests first
- confirm the failure is for the intended reason
- implement the smallest code change to pass

## Verification Plan

Required checks before merge:

- targeted `bun test` runs for touched modules
- full `bun test`
- `bun run typecheck`
- optional `bun run web:build` only if operator-visible status surfaces are touched

## Risks

- over-trimming evidence could make the evaluator under-informed
- changing state-change composition could accidentally hide legitimate workspace mutations
- summary changes could create new mismatches with existing round artifact tests

## Mitigations

- preserve raw artifacts on disk even when prompts become compact
- prefer artifact path references plus small excerpts over removing evidence entirely
- add tests around both prompt composition and persisted artifact contents
