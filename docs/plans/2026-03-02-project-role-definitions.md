# Project Role Definitions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add project-scoped AI-generated role definition files under `.ailoop/` and load them into Planner/Executor/Evaluator prompts.

**Architecture:** Introduce a dedicated role-definition manager that ensures role docs exist (generate on missing, fallback to deterministic templates) and expose this via startup hooks and CLI command. Prompt builders in each role agent read their corresponding role file and prepend it as project-specific guidance while preserving existing hard constraints and output schemas.

**Tech Stack:** TypeScript (Bun runtime), existing CodexClient JSON schema flow, bun:test.

---

### Task 1: Add failing tests for role definition lifecycle

**Files:**
- Create: `src/agent/role-definitions.test.ts`
- Modify: `src/loop/state.test.ts`

**Step 1: Write failing tests for generation behavior**

```ts
// src/agent/role-definitions.test.ts
// - creates all three role files when missing
// - does not overwrite existing files unless regen=true
// - falls back to templates when codex generation fails
```

**Step 2: Run tests to verify failure**

Run: `bun test src/agent/role-definitions.test.ts src/loop/state.test.ts`
Expected: FAIL because role manager and role paths do not exist.

**Step 3: Implement minimal structures in tests for path expectations**

```ts
expect(paths.plannerRolePath.endsWith("PLANNER_ROLE.md")).toBe(true)
```

**Step 4: Re-run tests**

Run: `bun test src/agent/role-definitions.test.ts src/loop/state.test.ts`
Expected: still FAIL with missing implementation symbols.

### Task 2: Add failing tests for prompt injection and CLI roles command

**Files:**
- Modify: `src/agent/planner.test.ts`
- Create: `src/agent/executor.test.ts`
- Modify: `src/evaluation/strategies/llm-judge.test.ts`
- Modify: `scripts/ailoop.ts` tests if available, else create focused command parser test around new handler

**Step 1: Add failing planner/executor/evaluator prompt tests**

```ts
// assert prompt includes "Project-specific ... Role Definition"
// when role markdown content is provided
```

**Step 2: Add failing CLI roles generate test (or handler unit test)**

```ts
// roles generate --regen triggers ensureRoleDefinitions(... regen=true)
```

**Step 3: Run tests to verify failure**

Run: `bun test src/agent/planner.test.ts src/agent/executor.test.ts src/evaluation/strategies/llm-judge.test.ts`
Expected: FAIL due to missing new helpers/exports.

### Task 3: Implement role definition manager and state wiring

**Files:**
- Create: `src/agent/role-definitions.ts`
- Modify: `src/loop/state.ts`
- Modify: `src/types/contracts.ts` only if needed for new role generation payload typing

**Step 1: Implement manager with read-before-write safeguards**

```ts
export async function ensureRoleDefinitions(options: EnsureRoleDefinitionsOptions): Promise<EnsureRoleDefinitionsResult>
```

Behavior:
- if `regen=false`, only generate missing files
- if `regen=true`, regenerate all three
- generation input from `.ailoop/goal.md` + workspace `README.md`
- on generation failure, write deterministic templates

**Step 2: Add role paths to LoopPaths**

```ts
plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md")
```

**Step 3: Ensure `.ailoop` baseline remains idempotent**

Run: `bun test src/loop/state.test.ts src/agent/role-definitions.test.ts`
Expected: PASS.

### Task 4: Implement prompt integration and startup/CLI hooks

**Files:**
- Modify: `src/agent/planner.ts`
- Modify: `src/agent/executor.ts`
- Modify: `src/evaluation/strategies/llm-judge.ts`
- Modify: `src/loop/control.ts`
- Modify: `scripts/ailoop.ts`

**Step 1: Prepend role content in prompts**

```ts
const roleBlock = await readRoleDefinition(...)
prompt = [roleBlock, existingPrompt].join("\n\n")
```

**Step 2: Ensure roles on start/run**

- `startBackgroundLoop` ensures roles before spawning
- foreground `run` ensures roles before engine execution

**Step 3: Add CLI command**

- `roles generate [--regen]`

**Step 4: Run targeted tests**

Run: `bun test src/agent/planner.test.ts src/agent/executor.test.ts src/evaluation/strategies/llm-judge.test.ts src/loop/control.test.ts`
Expected: PASS.

### Task 5: Update docs and run full verification

**Files:**
- Modify: `README.md`

**Step 1: Document role files and commands**

- `.ailoop/PLANNER_ROLE.md`, `.ailoop/EXECUTOR_ROLE.md`, `.ailoop/EVALUATOR_ROLE.md`
- auto-generation behavior and `--regen`

**Step 2: Run full checks**

Run: `bun test`
Expected: PASS

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src scripts README.md docs/plans/2026-03-02-project-role-definitions.md
git commit -m "feat: add project-scoped role definition generation"
```
