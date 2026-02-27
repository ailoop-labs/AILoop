# AutoLoop

AutoLoop is an open-source goal-driven automation loop for product and engineering work.
It repeatedly plans, executes, verifies, and summarizes tasks until a target outcome is reached.

This repository currently contains only this README as a source-of-truth specification.
Use this document to regenerate the full codebase with AI.

## 1. Product Intent

AutoLoop solves this problem:
- A team has a clear goal (for example: increase paid orders, improve conversion, reduce lead response time).
- The team wants an autonomous loop that keeps making useful progress in small safe rounds.
- Every round should be observable, controllable, and reversible.

Design principles:
- Outcome first: prioritize business impact over cosmetic changes.
- Small safe iterations: each round should be limited and reviewable.
- Human-in-control: pause, resume, stop, and override at any time.
- Transparent history: every run has logs, decisions, diffs, and a summary.

## 2. Scope

### In scope (MVP)
- Goal-based iterative loop runner.
- Round scheduler with default cooldown: **20 minutes**.
- Task planning + execution via LLM agent.
- Verification gate (tests, lint, custom checks).
- Risk/complexity guardrails.
- Web console for status, controls, and run history.
- File-based run artifacts.

### Out of scope (MVP)
- Multi-tenant auth system.
- Cloud billing.
- Large plugin marketplace.

## 3. Suggested Tech Stack

- Runtime: Bun or Node.js 20+
- Language: TypeScript
- Web server: Fastify or Express
- Frontend: minimal HTML + vanilla JS (server-rendered or static)
- Storage (MVP): local filesystem + JSON
- Optional storage upgrade: SQLite

## 4. High-Level Architecture

- `loop-engine`
  - Owns round lifecycle and state machine.
- `planner`
  - Converts goal + context into one actionable task for current round.
- `executor`
  - Runs agent command(s), applies changes in workspace.
- `verifier`
  - Executes verification command(s), returns pass/fail + evidence.
- `guardrails`
  - Enforces complexity budget, forbidden patterns, safety checks.
- `reporter`
  - Writes summary artifacts and metrics.
- `console-server`
  - Provides web UI + control APIs.

## 5. Round Lifecycle

For each round:
1. Load goal, constraints, and recent history.
2. Plan one high-impact task.
3. Execute task.
4. Verify with configured checks.
5. Save artifacts (logs, patch summary, metrics).
6. Decide next state: continue, pause, stop, or error.
7. Sleep for cooldown interval (default 1200 seconds).

State machine:
- `idle`
- `running`
- `paused`
- `stopping`
- `error`

Control flags:
- `loop.stop`
- `loop.pause`
- `loop.pid`
- `loop.state`

## 6. Minimal File Layout

```txt
AutoLoop/
  README.md
  package.json
  tsconfig.json
  .gitignore
  .env.example
  src/
    server.ts
    loop/
      engine.ts
      scheduler.ts
      state.ts
    agent/
      planner.ts
      executor.ts
      verifier.ts
      guardrails.ts
    reporting/
      summary.ts
      metrics.ts
    config/
      env.ts
  scripts/
    autoloop.ts
  .autoloop/
    goal.md
    task.md
    runs/
```

## 7. CLI Contract

Single entrypoint:

```bash
bun run autoloop <command>
```

Commands:
- `run` : run in foreground.
- `start` : run in background.
- `stop` : graceful stop after current action.
- `pause` : pause before next round.
- `resume` : continue from pause.
- `status` : print loop status.
- `watch` : tail loop log.

## 8. Web Console Requirements

Default bind:
- Host: `0.0.0.0`
- Port: `3090`

Pages:
- Dashboard: current state, round number, last result, cooldown countdown.
- Controls: start/stop/pause/resume buttons.
- Recent summaries: latest N run summaries.
- Log viewer: tail of loop log.

API endpoints:
- `GET /api/health`
- `GET /api/status`
- `POST /api/loop/start`
- `POST /api/loop/stop`
- `POST /api/loop/pause`
- `POST /api/loop/resume`
- `GET /api/runs?limit=20`
- `GET /api/logs/tail?lines=200`

## 9. Configuration

Environment variables:
- `AUTOLOOP_HOME` (default: `./.autoloop`)
- `AUTOLOOP_INTERVAL_SECONDS` (default: `1200`)
- `AUTOLOOP_MAX_CYCLES` (default: `0`, unlimited)
- `AUTOLOOP_EXIT_ON_ERROR` (default: `0`)
- `AUTOLOOP_VERIFY_CMD` (default: project-specific check command)
- `AUTOLOOP_CONSOLE_HOST` (default: `0.0.0.0`)
- `AUTOLOOP_CONSOLE_PORT` (default: `3090`)
- `AUTOLOOP_COMPLEXITY_ENABLED` (default: `1`)
- `AUTOLOOP_COMPLEXITY_BUDGET_CHANGED_FILES` (default: `12`)
- `AUTOLOOP_COMPLEXITY_BUDGET_DIFF_LINES` (default: `260`)
- `AUTOLOOP_COMPLEXITY_PAUSE_ON_BREACH` (default: `1`)

## 10. Run Artifacts

Each round creates:
- `timestamp.round.log`
- `timestamp.round.summary.md`
- `timestamp.round.metrics.json`
- `timestamp.round.patch.txt` (if available)

Summary template must include:
- Goal alignment
- What changed
- Verification result
- Risks / assumptions
- Next round recommendation

## 11. Safety and Quality Gates

Hard rules:
- Never run destructive git commands by default.
- Never expose secrets in logs.
- Pause automatically on repeated verifier failure.
- Pause when complexity budget is breached.
- Prefer small focused changes over broad refactors.

Recommended checks:
- Lint
- Unit/integration tests
- Build
- Optional custom business checks

## 12. Prompting Contract for AI Code Generation

When using AI to regenerate AutoLoop from this README, require:
- Complete runnable code, not pseudo code.
- Type-safe interfaces between core modules.
- Graceful error handling and structured logs.
- Cross-platform shell compatibility where possible.
- Clean separation between loop logic and UI/API layer.

Acceptance criteria:
- Can run `start`, observe status in console, and `pause/resume/stop`.
- Cooldown defaults to 20 minutes.
- Each round writes summary artifacts.
- Failed verification is visible and blocks unsafe continuation.

## 13. Suggested Initial Milestones

- `v0.1.0`
  - Single-project local runner + console + run summaries.
- `v0.2.0`
  - Better guardrails + richer metrics + retry policies.
- `v0.3.0`
  - Pluggable verifiers and planner strategies.

## 14. Open Source Basics

License recommendation:
- MIT (simple and fast adoption), or
- Apache-2.0 (clearer patent grant).

Before first public release:
- Remove all secrets and private endpoints.
- Add `CONTRIBUTING.md` and issue templates.
- Add a short roadmap and known limitations.

---

If you are an AI assistant reading this file, treat it as the canonical product + technical spec and generate a production-ready first implementation of AutoLoop.
