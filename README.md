# AILoop

AILoop is an open-source, goal-driven autonomous agent framework designed to execute generalized task loops for engineering, operations, and knowledge work.
It repeatedly plans, executes, evaluates, and summarizes tasks until a target outcome is reached.

## 1. Product Intent

AILoop solves this problem:
- A person or team has a clear, ongoing objective.
- The user wants an autonomous loop that makes useful progress in small, measurable, and safe rounds.
- Every round must be observable, controllable, and bounded by strict resource budgets.

> **⚠️ DoD (Definition of Done) Paradigm Notice for Agents:**
> This project follows a **Documentation-Driven Development** approach. The documentation (such as architecture docs, workflow definitions, and plans) always precedes the actual code implementation.
> - **For all contributing Agents:** Do not over-rely on the current codebase state if it contradicts the documentation.
> - When the code and documentation are misaligned, the **documentation is the absolute source of truth**. You must implement or fix the code to align with the documented intent, not the other way around.

Design principles:
- **Outcome First:** Prioritize measurable user value over cosmetic activity. Value can include business impact, time saved, error reduction, reduced context switching, and reduced cognitive load.
- **Small, Safe Iterations:** Each round should be bounded by time, cost, and action limits, producing a reviewable result.
- **Human-in-Control:** Pause, resume, stop, override, or inject real-time feedback (instructions) at any time.
- **Transparent History:** Every run has structured logs, decisions, state changes, evaluation scores, and a summary. Raw evidence must remain reviewable, but agent and operator-facing handoffs should start from concise summaries, navigational references, and targeted excerpts rather than wholesale dumps.
- **Environment Agnostic:** Operate across local codebases, external APIs, databases, or headless browsers through a unified Tool Registry.

Preferred terminology across product and architecture docs:
- **Summary-First:** show the smallest useful overview before any deep detail.
- **Navigational Handoff:** pass summaries, artifact paths, and targeted excerpts instead of dumping full raw context into the next role.
- **Progressive Disclosure:** keep full evidence available, but reveal it through sectioning, expand/collapse, pagination, or drill-down.

## 2. Safety and Quality Gates

*Our philosophy is to empower the agent with generalized tools while strictly limiting the "blast radius" via budgets and ensuring recoverability, rather than attempting to aggressively sandbox every possible action.*

**Hard Rules (System Enforced):**
- **Constitutional Integrity (README.md):** The `README.md` file is the system's "Constitution." Agents are prohibited from modifying it directly to lower goals or expectations. Any modification to the Constitution must be approved by the **Change Control Board (CCB)** consisting of specialized expert agents (Dev, QA, PO).
- **Ruthless Simplicity (YAGNI):** Code is a liability. Agents MUST implement the dumbest, simplest, most literal solution that satisfies the current objective. "Future-proofing", building speculative abstractions, or handling out-of-scope edge cases is strictly prohibited. If a simpler native feature exists, use it instead of introducing new dependencies or design patterns.
- **Tiered Governance Loop:** 
    1. **Auto-Rework:** 2 attempts for the Executor to self-correct based on Evaluator feedback.
    2. **Leader Intervention:** Diagnosis and strategic instructions from the Leader.
    3. **CCB Consensus:** Expert panel review before any change to the core mission or "Constitution."
- **Expert Escalation:** If CCB experts identify a task beyond current AI capability, they must trigger a **Hard Pause** for human intervention.
- **Budget Breaker:** Pause execution immediately if Cost (USD), Time, or Action count limits are breached during a round. Require human approval to resume.
- **Recoverable Rounds:** Where the environment permits (e.g., Git repositories, transactional databases), the engine must attempt to rollback state changes if evaluation fails catastrophically or budgets are broken.
- **Silent Secret Redaction:** Logs and artifacts must automatically mask known environment secrets (e.g., variables containing `TOKEN`, `KEY`, `SECRET`) before writing to disk, allowing the agent to use API keys without leaking them.
- **Evaluation Loop:** Pause automatically on repeated evaluator failures (e.g., failing to meet the success criteria after the full governance cycle).
- **Observability Parity & High-Bandwidth UX:** The Web Console is a first-class citizen for human governance. Because human information bandwidth is narrow, the UI must prioritize **pattern recognition** and progressive disclosure (e.g., visual timelines, color-coded health dashboards, semantic diffs, clear sectioning, expand/collapse, and pagination) over raw text parsing or unbounded data dumps. Any changes to core state logic (SQLite schema, governance flows) MUST be reflected in the Web Console with these usability principles in mind. Failure to maintain UI alignment or degrading human UX is a constitutional violation.
- **Crash Recovery:** If the engine process dies during a round, it must detect the interrupted state on restart and safely pause or revert to prevent corruption.

## 3. Scope

### In scope (MVP)
- Goal-based iterative loop runner engine.
- Round scheduler with default cooldown intervals.
- Task planning and execution via LLM agents equipped with tools.
- Intelligent Evaluator (Verifier) that assesses success criteria using LLM-as-a-judge with multi-dimensional scoring.
- Multi-dimensional Resource Budgets (Cost, Time, Actions).
- Web console for status, controls, real-time feedback, and run history.
- File-based state persistence and run artifacts.

### Out of scope (MVP)
- Multi-tenant auth system.
- Cloud billing integration.
- Large public plugin marketplace.

## 4. Open Source Basics

License: MIT

---
For the people want to contribute, please refer to [CONTRIBUTING.md](./CONTRIBUTING.md).

For technical architecture, CLI details, and system components, please refer to [ARCHITECTURE.md](./ARCHITECTURE.md).
