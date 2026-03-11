# AILoop Roadmap

This document captures the short project roadmap and current known limitations referenced by the public-release checklist in [README.md](./README.md). It is scoped to the MVP boundaries defined in [ARCHITECTURE.md](./ARCHITECTURE.md).

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

## Release Checklist Context

Before first public release, the repository still needs the adjacent open-source basics called out in [README.md](./README.md):

- remove any secrets and private endpoints,
- add `CONTRIBUTING.md` and issue templates,
- publish and keep this short roadmap and known limitations document in sync with the implemented MVP.
- maintain `## Source Traceability` so release review can confirm that `## Short Roadmap` and `## Known Limitations` still match the README release requirement and the in-scope and out-of-scope MVP boundaries in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Source Traceability

- [README.md](./README.md) requires a short roadmap and known limitations before first public release. In this document, `## Short Roadmap` is the publishable milestone view of MVP delivery, and `## Known Limitations` is the release-facing disclosure of the MVP constraints and explicit non-goals.
- The [ARCHITECTURE.md](./ARCHITECTURE.md) MVP system boundaries map directly to the roadmap items:
  - loop engine, agent contracts, budget enforcement, file-based persistence, and built-in tools are tracked under `### 1. Complete the MVP foundation`,
  - CLI, web console, and control API responsibilities are tracked under `### 2. Deliver control surfaces for operators`,
  - recoverable rounds, pause behavior, crash recovery, rollback hooks, and secret redaction are tracked under `### 3. Harden recovery and evaluation paths`.
- The architecture out-of-scope items also anchor `## Known Limitations`, which keeps multi-tenant auth, billing, marketplace, distributed-worker, and horizontal-scaling work outside this MVP roadmap unless the source documents change.

| Source contract | Roadmap coverage in this file | Release implication |
| --- | --- | --- |
| README.md: "Add a short roadmap and known limitations" before first public release | `## Short Roadmap` is the publishable milestone plan and `## Known Limitations` is the paired disclosure section required for release readiness. | Public-release checklist completion depends on both sections remaining present and synchronized with the implemented MVP. |
| ARCHITECTURE.md: MVP in-scope capabilities | `### 1. Complete the MVP foundation`, `### 2. Deliver control surfaces for operators`, and `### 3. Harden recovery and evaluation paths` partition the architecture's engine, control-plane, and safety/recovery scope into delivery buckets. | Progress on roadmap items can be judged against the architecture contract instead of inferred from generic roadmap wording. |
| ARCHITECTURE.md: MVP out-of-scope boundaries | `## Known Limitations` preserves the architecture exclusions for multi-tenant auth, billing, marketplace, distributed workers, and horizontal scaling as explicit non-goals. | The roadmap does not silently expand beyond MVP; deferred work stays visible until the source architecture changes. |

## Known Limitations

- The current contract is MVP-only and intentionally limited to a single run for one workspace.
- Persistence is file-based under `.ailoop/`; there is no multi-tenant or hosted control plane in scope.
- Tooling is intentionally small. The documented built-ins are `read_file`, `write_file`, `run_shell`, and `http_request`.
- Rollback is environment-dependent. Git-backed or transactional environments may support recovery, but non-recoverable environments require pause and human review.
- Safety relies on strict budgets and pause semantics, not perfect sandboxing of every side effect.
- The evaluator is designed to judge observable success, but repeated failures are expected to pause the system rather than guarantee autonomous recovery.
- The MVP explicitly excludes multi-tenant auth, cloud billing integration, a public plugin marketplace, distributed workers, and horizontal scaling.
