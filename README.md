# AutoLoop

AutoLoop is an open-source, goal-driven autonomous agent framework designed to execute generalized task loops for engineering, operations, and knowledge work.
It repeatedly plans, executes, evaluates, and summarizes tasks until a target outcome is reached.

This repository currently contains only this README as a source-of-truth specification.
Use this document to regenerate the full codebase with AI.

## 1. Product Intent

AutoLoop solves this problem:
- A person or team has a clear, ongoing objective.
- The user wants an autonomous loop that makes useful progress in small, measurable, and safe rounds.
- Every round must be observable, controllable, and bounded by strict resource budgets.

Design principles:
- **Outcome First:** Prioritize measurable user value over cosmetic activity. Value can include business impact, time saved, error reduction, reduced context switching, and reduced cognitive load.
- **Small, Safe Iterations:** Each round should be bounded by time, cost, and action limits, producing a reviewable result.
- **Human-in-Control:** Pause, resume, stop, override, or inject real-time feedback (instructions) at any time.
- **Transparent History:** Every run has structured logs, decisions, state changes, evaluation scores, and a summary.
- **Environment Agnostic:** Operate across local codebases, external APIs, databases, or headless browsers through a unified Tool Registry.

## 2. Scope

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

## 3. Suggested Tech Stack

- Runtime: Bun or Node.js 20+
- Language: TypeScript
- Web server: Fastify or Express
- Frontend: Minimal HTML + vanilla JS (server-rendered or static)
- Storage (MVP): Local filesystem + JSON
- Optional storage upgrade: SQLite

## 4. High-Level Architecture

- `loop-engine`
  - Owns round lifecycle, locking, and state machine.
- `planner`
  - Analyzes the overarching goal, recent history, and human instructions to define one actionable sub-task for the current round.
- `tool-registry`
  - Manages available skills/tools (e.g., `read_file`, `run_shell`, `web_search`, `sql_query`, `http_request`).
- `executor`
  - An agentic loop that utilizes tools from the registry to complete the planned sub-task, handling intermediate errors and self-correction.
- `evaluator` (formerly Verifier)
  - Executes validation logic (e.g., running tests, checking defined outcome indicators, or prompting an LLM judge) to determine if the round was successful and safe.
- `guardrails`
  - Enforces resource budgets (Cost/Tokens, Time, Actions) and safety policies (e.g., forbidden API calls or shell commands).
- `reporter`
  - Writes summary artifacts, metrics, and state-change diffs.
- `console-server`
  - Provides the Web UI and control APIs.

## 5. Round Lifecycle

For each round:
1. **Acquire Lock:** Obtain `loop.lock` to prevent concurrent execution in the same workspace.
2. **Snapshot State (Optional but Recommended):** Create a recoverable snapshot of the environment (e.g., `git stash` for codebases, or a database transaction checkpoint).
3. **Contextualize:** Load the main goal, constraints, human instructions/feedback, and recent run history.
4. **Plan:** Synthesize a single, high-impact sub-task bounded by the current budget.
5. **Execute:** The Executor iteratively uses tools to complete the sub-task.
6. **Evaluate:** Run the configured Evaluator(s). If evaluation fails catastrophically or breaks constraints, trigger a rollback (if supported by the environment).
7. **Persist:** Save artifacts (logs, summary, metrics, state-change patch) and commit the changes if successful.
8. **Decide Next State:** Transition to continue, pause (e.g., waiting for human approval), stop, or error.
9. **Cooldown:** Sleep for the configured interval (default 1200 seconds).

State machine:
- `idle`
- `running`
- `cooldown` (resting between rounds)
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
      tool-registry.ts
    evaluation/
      evaluator.ts
      strategies/
        shell-script.ts
        llm-judge.ts
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
- `run` : Run in the foreground.
- `start` : Run in the background.
- `stop` : Graceful stop after the current action completes.
- `pause` : Pause before the next round starts.
- `resume` : Continue execution from a paused state.
- `status` : Print current loop status and budget consumption.
- `watch` : Tail the live loop log.
- `instruct <message>` : Inject real-time human feedback or guidance into the planner for the next round.

### Operator-friendly startup

To minimize CLI usage in daily operation, provide two startup scripts:
- `scripts/dev.sh`
  - Starts API server + Vite UI for development.
  - Web UI is the primary control surface for loop start/pause/resume/stop.
- `scripts/prod.sh`
  - Builds Web UI and starts API server that serves static Web assets.
  - Web UI is the primary control surface for loop operations and runtime parameter changes.
  - If `.env` leaves `AUTOLOOP_CONSOLE_ADMIN_TOKEN` empty, `prod.sh` auto-generates one daily token, reuses it on same UTC date, and rotates it after UTC date changes.
  - Optional: pass `daemon` to run in background (`bash scripts/prod.sh daemon`).
  - Optional: pass `stop` to stop the daemon (`bash scripts/prod.sh stop`).
  - Optional: pass `restart` to gracefully restart the daemon (`bash scripts/prod.sh restart`).

## 8. Web Console Requirements

Default bind:
- Host: `0.0.0.0`
- Port: `3090`

Pages:
- **Dashboard:** Current state, round number, last evaluation result, active budgets, cooldown countdown.
- **Controls:** Start/stop/pause/resume buttons, and a text input for human instructions.
- **History:** Latest N run summaries, highlighting budget usage and outcome.
- **Log Viewer:** Tail of the active loop log.

API endpoints:
- `GET /api/health`
- `GET /api/auth/status` (returns `{ "tokenRequired": boolean }`)
- `POST /api/auth/login` (body: `{ "token": "..." }`)
- `GET /api/status`
- `GET /api/goal`
- `GET /api/config`
- `POST /api/config`
- `POST /api/config/reset`
- `POST /api/loop/start`
- `POST /api/loop/stop`
- `POST /api/loop/pause`
- `POST /api/loop/resume`
- `POST /api/loop/instruct` (body: `{ "message": "..." }`)
- `GET /api/runs?limit=20`
- `GET /api/logs/tail?lines=200`

## 9. Configuration

Environment variables:
- `AUTOLOOP_HOME` (default: `./.autoloop`)
- `AUTOLOOP_INTERVAL_SECONDS` (default: `1200`)
- `AUTOLOOP_MAX_CYCLES` (default: `0`, unlimited; when >0, each start/run executes at most this many rounds before stopping)
- `AUTOLOOP_EXIT_ON_ERROR` (default: `0`)
- `AUTOLOOP_CONSOLE_HOST` (default: `0.0.0.0`)
- `AUTOLOOP_CONSOLE_PORT` (default: `3090`)
- `AUTOLOOP_CONSOLE_ADMIN_TOKEN` (default: empty, when set all non-public `/api/*` routes require matching Bearer token)
- `AUTOLOOP_MAX_RETAIN_RUNS` (default: `50`, auto-cleans old run artifacts)

**Multi-dimensional Budgets (Guardrails):**
- `AUTOLOOP_BUDGET_USD_PER_ROUND` (default: `0.5`, maximum LLM cost per round)
- `AUTOLOOP_BUDGET_TIME_MINUTES` (default: `15`, maximum execution time per round)
- `AUTOLOOP_BUDGET_ACTIONS` (default: `30`, maximum tool/API calls per round)

**Evaluator Configuration:**
- `AUTOLOOP_EVALUATOR_TYPE` (default: `shell`, options: `shell`, `llm`, `webhook`)
- `AUTOLOOP_EVALUATOR_CMD` (used if type is `shell`, e.g., `npm test` or `./check-db.sh`)
- `AUTOLOOP_LLM_EVALUATOR_DIMENSIONS` (used when type is `llm`; comma-separated dimensions:
  `goal_alignment,causal_validity,constraint_compliance,risk_externality,reversibility_resilience,learning_yield`)
- `AUTOLOOP_LLM_EVALUATOR_MIN_PASS_SCORE` (used when type is `llm`; default: `75`)

## 10. Run Artifacts

Each round creates the following in `.autoloop/runs/`:
- `timestamp.round.log`
- `timestamp.round.summary.md`
- `timestamp.round.metrics.json` (Includes cost, duration, action count)
- `timestamp.round.state_change.txt` (A generalized diff, e.g., git patch, SQL statements executed, or API payload summaries)

Summary template must include:
- Goal alignment
- Actions taken (Tools used)
- Evaluation result
- Budget consumed vs. Limit
- Risks / assumptions
- Next round recommendation

## 11. Safety and Quality Gates

*Our philosophy is to empower the agent with generalized tools while strictly limiting the "blast radius" via budgets and ensuring recoverability, rather than attempting to aggressively sandbox every possible action.*

**Hard Rules (System Enforced):**
- **Budget Breaker:** Pause execution immediately if Cost (USD), Time, or Action count limits are breached during a round. Require human approval to resume.
- **Recoverable Rounds:** Where the environment permits (e.g., Git repositories, transactional databases), the engine must attempt to rollback state changes if evaluation fails catastrophically or budgets are broken.
- **Silent Secret Redaction:** Logs and artifacts must automatically mask known environment secrets (e.g., variables containing `TOKEN`, `KEY`, `SECRET`) before writing to disk, allowing the agent to use API keys without leaking them.
- **Evaluation Loop:** Pause automatically on repeated evaluator failures (e.g., failing to meet the success criteria after 3 consecutive attempts).
- **Crash Recovery:** If the engine process dies during a round, it must detect the interrupted state on restart and safely pause or revert to prevent corruption.

## 12. Prompting Contract for AI Code Generation

When using AI to regenerate AutoLoop from this README, require:
- Complete runnable code, not pseudo code.
- Type-safe interfaces between core modules (specifically `Tool` and `Evaluator` interfaces).
- Graceful error handling and structured logs with secret redaction.
- Cross-platform shell compatibility where applicable.
- Clean separation between the engine logic, tool registry, and UI/API layer.

Acceptance criteria:
- Can run `start`, observe status in console, and `pause/resume/stop`.
- Cooldown defaults to 20 minutes.
- The Executor can load at least two distinct tools (e.g., a shell executor and a simple HTTP client).
- Each round correctly tracks and respects the Action and Time budgets, writing accurate summary artifacts.
- Failed evaluations are visible in the console and block unsafe continuation.

## 13. Suggested Initial Milestones

- `v0.1.0`
  - Core engine + Web Console + Shell/HTTP Tools + Multi-dimensional Budgets.
- `v0.2.0`
  - Pluggable Evaluators (LLM-as-a-judge) + Complex Workspace Rollbacks (Git/DB).
- `v0.3.0`
  - Advanced Tool Registry (Browser automation, specific SaaS API integrations).

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
