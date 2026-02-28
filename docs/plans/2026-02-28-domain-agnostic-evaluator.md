# Domain-Agnostic Evaluator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace role-based reviewer thinking with six domain-agnostic evaluation dimensions and deterministic aggregation.

**Architecture:** Extend evaluator contracts with per-dimension assessments and aggregate output. Keep engine compatibility by preserving top-level pass/fail while adding rich evidence for summary and future policy gates. Use config flags to enable/disable dimensions safely.

**Tech Stack:** TypeScript, Bun runtime, existing CodexClient JSON-schema calls.

---

### Task 1: Add contracts for dimension evaluation artifacts

**Files:**
- Modify: `src/types/contracts.ts`

**Step 1: Write the failing test**
- Add a type-level/runtime-usage test that expects `EvaluationResult` to optionally include `dimensions` and `aggregate_score`.

**Step 2: Run test to verify it fails**
- Run: `bun test tests/evaluation/llm-judge.test.ts`
- Expected: compile/runtime failure due to missing fields.

**Step 3: Write minimal implementation**
- Add `EvaluationDimension`, `DimensionAssessment`, and optional fields on `EvaluationResult`.

**Step 4: Run test to verify it passes**
- Run same test.

### Task 2: Implement multi-dimension LLM judge aggregation

**Files:**
- Modify: `src/evaluation/strategies/llm-judge.ts`

**Step 1: Write the failing test**
- Add tests for:
  - hard-gate fail when compliance/risk fails
  - pause recommendation when unknown on key dimensions
  - pass only when weighted score >= threshold and no blockers

**Step 2: Run test to verify it fails**
- Run targeted test file and confirm expected assertions fail.

**Step 3: Write minimal implementation**
- Introduce per-dimension prompting with shared schema.
- Aggregate decisions using deterministic gate+weights.
- Map to existing `EvaluationResult` surface.

**Step 4: Run test to verify it passes**
- Run targeted tests.

### Task 3: Add configuration for dimensions and thresholds

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/runtime.ts`

**Step 1: Write the failing test**
- Extend config tests to expect parsing of evaluator dimensions and min pass score.

**Step 2: Run test to verify it fails**
- Run config tests.

**Step 3: Write minimal implementation**
- Add env parsing:
  - `AUTOLOOP_LLM_EVALUATOR_DIMENSIONS`
  - `AUTOLOOP_LLM_EVALUATOR_MIN_PASS_SCORE`

**Step 4: Run test to verify it passes**
- Run tests.

### Task 4: Document and verify full build

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Step 1: Write the failing test**
- N/A (docs-only)

**Step 2: Implement docs update**
- Add domain-agnostic evaluator section and env vars.

**Step 3: Verify**
- Run: `bun run typecheck`
- Run: `bun test`

