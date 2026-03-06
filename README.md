# AILoop

AILoop is an open-source, goal-driven autonomous agent framework designed to execute generalized task loops for engineering, operations, and knowledge work.
It repeatedly plans, executes, evaluates, and summarizes tasks until a target outcome is reached.

This repository currently contains only this README as a source-of-truth specification.
Use this document to regenerate the full codebase with AI.

## 1. Product Intent

AILoop solves this problem:
- A person or team has a clear, ongoing objective.
- The user wants an autonomous loop that makes useful progress in small, measurable, and safe rounds.
- Every round must be observable, controllable, and bounded by strict resource budgets.

Design principles:
- **Outcome First:** Prioritize measurable user value over cosmetic activity. Value can include business impact, time saved, error reduction, reduced context switching, and reduced cognitive load.
- **Small, Safe Iterations:** Each round should be bounded by time, cost, and action limits, producing a reviewable result.
- **Human-in-Control:** Pause, resume, stop, override, or inject real-time feedback (instructions) at any time.
- **Transparent History:** Every run has structured logs, decisions, state changes, evaluation scores, and a summary.
- **Environment Agnostic:** Operate across local codebases, external APIs, databases, or headless browsers through a unified Tool Registry.

## 2. Safety and Quality Gates

*Our philosophy is to empower the agent with generalized tools while strictly limiting the "blast radius" via budgets and ensuring recoverability, rather than attempting to aggressively sandbox every possible action.*

**Hard Rules (System Enforced):**
- **Budget Breaker:** Pause execution immediately if Cost (USD), Time, or Action count limits are breached during a round. Require human approval to resume.
- **Recoverable Rounds:** Where the environment permits (e.g., Git repositories, transactional databases), the engine must attempt to rollback state changes if evaluation fails catastrophically or budgets are broken.
- **Silent Secret Redaction:** Logs and artifacts must automatically mask known environment secrets (e.g., variables containing `TOKEN`, `KEY`, `SECRET`) before writing to disk, allowing the agent to use API keys without leaking them.
- **Evaluation Loop:** Pause automatically on repeated evaluator failures (e.g., failing to meet the success criteria after 3 consecutive attempts).
- **Crash Recovery:** If the engine process dies during a round, it must detect the interrupted state on restart and safely pause or revert to prevent corruption.

## 3. Scope

### In scope (MVP)
- Goal-based iterative loop runner engine.
- Round scheduler with default cooldown intervals.
- Task planning and execution via LLM agents equipped with tools.
- Pluggable Evaluators (Verifiers) for diverse success criteria (e.g., shell scripts, LLM-as-a-judge, API metrics).
- Multi-dimensional Resource Budgets (Cost, Time, Actions).
- Web console for status, controls, real-time feedback, and run history.
- File-based state persistence and run artifacts.

### Out of scope (MVP)
- Multi-tenant auth system.
- Cloud billing integration.
- Large public plugin marketplace.

## 4. Open Source Basics

License: MIT

Before first public release:
- Remove all secrets and private endpoints.
- Add `CONTRIBUTING.md` and issue templates.
- Add a short roadmap and known limitations.

---

For technical architecture, CLI details, and system components, please refer to [ARCHITECTURE.md](./ARCHITECTURE.md).