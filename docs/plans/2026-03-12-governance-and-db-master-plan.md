# AILoop Governance & Database Upgrade Master Plan

**Date:** 2026-03-12
**Status:** Strategic Implementation Planning
**Objective:** Transition AILoop from file-based single-agent iterations to a tiered governance system with SQLite-backed consensus (CCB).

---

## 1. System Architecture: The Tiered Governance Flow

The core principle is that **README.md is the Constitution**. Changes to it are the highest-gravity actions and must be filtered through a Change Control Board (CCB) after all tactical and strategic attempts have failed.

### Level 1: Tactical Auto-Rework (Max 2 Attempts)
- **Trigger:** Evaluator returns `fail`.
- **Action:** Executor attempts 2 rounds of self-correction based on Evaluator's `root_cause_analysis`.
- **Database:** Record each attempt in `rework_history`.

### Level 2: Strategic Intervention (Leader)
- **Trigger:** Level 1 fails (2 attempts).
- **Action:** `LeaderAgent` performs deep diagnosis.
- **Decision Branch A (Code/Config Issue):** Leader issues "Strategic Instructions" to Executor. No change to README.md.
- **Decision Branch B (Constitutional Conflict):** Leader identifies that the objective in README.md is unreachable or logically flawed. Escalates to CCB.
- **Constraint:** If Branch A fails twice (2 Leader-led rework rounds), escalation to CCB is mandatory.

### Level 3: Change Control Board (CCB Meeting)
- **Participants:** 
    - **Senior Dev Agent:** Focuses on architecture and technical debt.
    - **QA Lead Agent:** Focuses on test coverage and regression (specifically ensures missing tests identified in Round 66 are added).
    - **Product Owner Agent:** Focuses on user value and mission alignment.
- **Decision Rule:** Majority vote. QA and PO have veto power on safety/value.
- **Outcome:** Either approve `README.md` modification or Reject and force retry with new expert hints.

### Level 4: Human Escalation (Safety Valve)
- **Trigger:** CCB deadlock or any Expert Agent reports "Agent Incapacity" (Option C).
- **Action:** Hard Pause. Notify human operator for manual arbitration.

---

## 2. Data Layer: SQLite Digitization (`ailoop.db`)

We are replacing/augmenting the flat JSON files with a relational store to support Long-term Memory, Metrics, and fast UI queries.

### Schema Design (Reference: `src/types/contracts.ts`)

| Table Name | Primary Purpose | Key Columns |
| --- | --- | --- |
| `rounds` | Core metrics | `round_id`, `start_time`, `duration`, `cost`, `status` |
| `evaluations` | Quality gates | `round_id`, `decision`, `dimensions_json`, `root_cause` |
| `leader_strategies` | Strategic memory | `round_id`, `rationale`, `instructions`, `diagnosis_type` |
| `ccb_sessions` | Constitutional changes | `session_id`, `proposed_change`, `final_decision` |
| `expert_opinions` | Consensus trail | `session_id`, `expert_role`, `vote`, `rationale`, `incapacity_flag` |

### Implementation Pattern (Reference: `src/loop/state.ts`)
- Use `bun:sqlite` for zero-latency local storage.
- **Pattern:** `StateSync` hook. Every time `writeLoopState` is called, the system also executes an `INSERT/UPDATE` to SQLite.
- **Historical Querying:** Planner will now query the DB for the last 5 failures involving current files before starting a new Round.

---

## 3. Implementation Phases & Milestones

### Phase 1: Foundation (Current Focus)
- [ ] Initialize `ailoop.db` schema.
- [ ] Update `src/loop/state.ts` to support dual-write (JSON + DB).
- [ ] Implement `DatabaseManager` class in `src/utils/db.ts`.

### Phase 2: Tiered Logic Refactor
- [ ] Update `src/loop/engine.ts` to implement the 2x Rework -> Leader -> 2x Leader-Rework -> CCB logic.
- [ ] Enhance `Evaluator` to produce structured `root_cause` for the database.
- [ ] Update `LeaderAgent` to distinguish between "Implementation Failure" and "Constitutional Conflict".

### Phase 3: Virtual CCB Implementation
- [ ] Define System Prompts for Dev, QA, and PO Experts.
- [ ] Implement the `CCBSession` orchestrator.
- [ ] Add the "Expert Incapacity" trigger (Option C).

### Phase 4: UI & Observability
- [ ] Update Web Console to query SQLite endpoints.
- [ ] Create "CCB Debate Room" view.
- [ ] Add "Strategic Memory" visualization (Timeline of failed approaches).

---

## 4. Reference-based Meta-Prompting anchors
- **Anchor 1:** `src/loop/engine.ts` loop structure.
- **Anchor 2:** `src/agent/leader.ts` context construction.
- **Anchor 3:** `src/reporting/metrics.ts` for schema alignment.

---

*This plan is now the authoritative reference for the upgrade. Proceeding to Phase 1.*
