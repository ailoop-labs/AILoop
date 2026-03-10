---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code.
---

# Test-Driven Development (TDD) Framework

This skill reinforces the strict Test-Driven Development workflow. The Executor must follow this cycle to ensure high reliability and clear behavioral expectations before any production code is modified.

## The TDD Cycle

### 1. Read and Understand
*   Carefully read the task's `ACCEPTANCE` criteria.
*   Identify the exact conditions that must be met to declare the task finished.

### 2. Write the Failing Test (Red)
*   **Action:** Write a new test case (or modify an existing one) that asserts the expected behavior.
*   **Crucial Step:** Run the test suite *before* changing any production code.
*   **Expected Result:** The test MUST FAIL. If it passes, the test is invalid, or the feature already exists. You must see the exact failure related to the missing implementation.

### 3. Write Minimum Code (Green)
*   **Action:** Modify the production code (`src/`, `web/`, etc.) with the *absolute minimum* amount of code required to make the failing test pass.
*   **Rule:** Do not over-engineer. Do not add speculative "just in case" logic. Just satisfy the test.

### 4. Refactor
*   **Action:** Now that the test is passing, review the code for quality, performance, and adherence to project style guidelines.
*   **Rule:** The tests must continue to pass throughout the refactoring phase.

## Instructions for Executor
When assigned a task, your first command should be to create or locate the relevant test file. Do not start by modifying the core implementation. The Evaluator will look for explicit verification commands in your work summary; a newly passing test suite is the strongest evidence of success.
