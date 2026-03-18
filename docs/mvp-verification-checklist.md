# AILoop MVP Verification Checklist

This checklist maps the MVP success criteria from `README.md` and `ARCHITECTURE.md` to concrete verification checks with explicit pass/fail evidence.

## Preconditions
- Use workspace root: `/root/projects/AILoop`
- Use the default workspace runtime home for repeatability: `./.ailoop`
- Start from dependencies installed and database config prepared.

## 1) Core Loop End-to-End

| ID | Verification check (executable) | Pass evidence | Fail evidence |
|---|---|---|---|
| CL-1 | `bun run ailoop --help` | Output includes: `run`, `start`, `stop`, `pause`, `resume`, `status`, `watch`, `instruct` | Any required command missing |
| CL-2 | Foreground round: `bun run ailoop run` | Round executes plan -> execute -> evaluate -> persist; `.ailoop/runs/` gains a new timestamped round set | Command crashes, or round artifacts missing |
| CL-3 | Background lifecycle: `bun run ailoop start`, then `bun run ailoop status`, `bun run ailoop pause`, `bun run ailoop resume`, `bun run ailoop stop` | `status`/state files show valid transitions: `idle -> running -> paused -> running -> stopping -> idle` | Invalid transition, stuck state, or unhandled error state |
| CL-4 | Instruction injection: `bun run ailoop instruct "test instruction"` before next round | Next round planner context or logs show instruction consumed | Instruction not persisted/injected |

## 2) Web Console + API Contract

| ID | Verification check (executable) | Pass evidence | Fail evidence |
|---|---|---|---|
| WC-1 | Start UI/API: `bash scripts/prod.sh` | Console binds to `0.0.0.0:3090`; dashboard page responds | Server does not start or wrong bind/port |
| WC-2 | Browser usability smoke test of Dashboard/Controls/History/Log Viewer | Pages render and controls are operable from browser | Missing page sections or non-functional controls |
| WC-3 | API health/auth endpoints: `curl -sS http://127.0.0.1:3090/api/health`; `curl -sS http://127.0.0.1:3090/api/auth/status` | Health returns success; auth status returns JSON with `tokenRequired` boolean | Non-2xx or schema mismatch |
| WC-4 | Loop control endpoints: POST `/api/loop/start|pause|resume|stop|instruct` | Responses are 2xx and reflected in `/api/status` state | Endpoint missing, non-2xx, or state not updated |
| WC-5 | Config/goal/runs/log API coverage: GET `/api/status`, `/api/goal`, `/api/config`, `/api/runs?limit=20`, `/api/logs/tail?lines=200`; POST `/api/config`, `/api/config/reset`; POST `/api/auth/login` when token is enabled | All endpoints exist and return contract-conformant JSON | Missing endpoint, malformed JSON, or incompatible fields |

## 3) Guardrails Per Round

| ID | Verification check (executable) | Pass evidence | Fail evidence |
|---|---|---|---|
| GR-1 | Budget breaker test with tiny limits (e.g., `AILOOP_BUDGET_ACTIONS=1`) and run one round | Loop pauses on breach; reason indicates budget breach; no unsafe continuation | Loop keeps running after breach or reason absent |
| GR-2 | Evaluator-failure pause test: configure failing evaluator command and run rounds | After repeated failures (target: 3), state becomes `paused` automatically | Failures continue indefinitely without pause |
| GR-3 | Secret redaction test: set env var containing `TOKEN`/`SECRET`, trigger logs/artifacts | Raw secret never appears in `.ailoop/runs/*`; redacted token marker present | Secret value appears unredacted on disk |

## 4) Artifact Completeness + Auditability

| ID | Verification check (executable) | Pass evidence | Fail evidence |
|---|---|---|---|
| AR-1 | After a round, list latest timestamp: `ls -1 .ailoop/runs | sort | tail` | Matching set exists: `.round.log`, `.round.summary.md`, `.round.metrics.json`, `.round.state_change.txt` | Any required artifact missing |
| AR-2 | Inspect summary content | Summary contains: goal alignment, actions taken, evaluation result, budget consumed vs limit, risks/assumptions, next-round recommendation | Required summary sections missing |
| AR-3 | Inspect metrics JSON | Metrics include cost, duration, action count with numeric values | Missing keys or invalid types |
| AR-4 | Inspect state-change artifact | Contains reproducible diff/command-query summary with no unredacted secrets | Cosmetic/no-op artifact or leaked secret |

## 5) Quality Gates

| ID | Verification check (executable) | Pass evidence | Fail evidence |
|---|---|---|---|
| QG-1 | Type safety: `bun run tsc --noEmit` | Exit code 0, no type errors | Type errors reported |
| QG-2 | Test suite: `bun test` (or project test command) | Exit code 0 and evaluator-related tests pass | Failing tests |
| QG-3 | Failure explicitness: run with intentionally invalid config/evaluator | Failure is explicit, structured, and recoverable (state `paused` or `error` with concrete reason) | Silent failure, ambiguous error, or corrupted state |

## Execution Notes
- Run checks in isolated test runs where possible to avoid contaminating production loop state.
- Record command outputs and timestamps alongside this checklist for audit trails.
