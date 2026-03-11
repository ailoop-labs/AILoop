# AILoop Roadmap

## Short Roadmap

### 1. Complete the MVP foundation

Build the core runtime described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md):

- loop engine with explicit `idle`, `starting`, `running`, `cooldown`, `paused`, `stopping`, and `error` states,
- planner, executor, and evaluator contracts with strict machine-readable inputs and outputs,
- per-round budget enforcement for cost, time, and action count,
- file-based persistence and round artifacts under `.ailoop/`,
- built-in `read_file`, `write_file`, `run_shell`, and `http_request` tools.

### 2. Deliver control surfaces for operators

Ship the user controls required to safely run the loop:

- CLI commands for `start`, `pause`, `resume`, `stop`, `status`, and `instruct`,
- a web console for run status, budgets, round history, artifacts, and live instructions,
- a control API that separates operator interactions from round execution.

### 3. Harden recovery and evaluation paths

Bring the safety model up to the MVP contract:

- pre-round snapshots and rollback hooks where the environment supports recovery,
- crash detection and restart-time recovery that pauses for review,
- evaluator-driven pause behavior after repeated failures,
- secret redaction for logs and artifacts before persistence.

## Known Limitations

- The current contract is MVP-only and intentionally limited to a single run for one workspace.
- Persistence is file-based under `.ailoop/`; there is no multi-tenant or hosted control plane in scope.
- Tooling is intentionally small. The documented built-ins are `read_file`, `write_file`, `run_shell`, and `http_request`.
- Rollback is environment-dependent. Git-backed or transactional environments may support recovery, but non-recoverable environments require pause and human review.
- Safety relies on strict budgets and pause semantics, not perfect sandboxing of every side effect.
- The evaluator is designed to judge observable success, but repeated failures are expected to pause the system rather than guarantee autonomous recovery.
- The MVP explicitly excludes multi-tenant auth, cloud billing integration, a public plugin marketplace, distributed workers, and horizontal scaling.
