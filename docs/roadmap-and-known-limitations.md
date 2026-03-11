# AILoop Roadmap and Known Limitations

This document summarizes the public-facing roadmap and current limitations for the AILoop MVP based on the commitments in `README.md` and `ARCHITECTURE.md`.

## Roadmap

- Finish MVP verification against the documented success criteria for the loop engine, web console, budgets, artifacts, and evaluator flow.
- Complete release-readiness basics for open source publication, including issue templates, a secret and private endpoint audit, and contributor-facing documentation.
- Harden round safety behavior around pause semantics, rollback requests, crash recovery, and repeated evaluator failures so the engine consistently fails safe.
- Expand operator visibility through the web console and CLI so status, controls, live instructions, and run history remain reviewable and actionable.
- Preserve the MVP boundary while stabilizing core contracts for Planner, Executor, Evaluator, and the tool registry before any broader platform expansion.

## Known Limitations

- The MVP is intentionally limited to a single run for one workspace and does not provide multi-tenant orchestration.
- Persistence and artifacts are file-based under `AILOOP_HOME`, which keeps the system simple but is not yet designed for hosted scale.
- Rollback is environment-dependent: Git-backed or transactional targets can support recovery, while non-recoverable environments may require a human review pause instead.
- The built-in tool surface is intentionally narrow for the MVP and currently centers on file, shell, and HTTP operations.
- Evaluator quality depends on the available evidence and can still require human judgment when task outcomes are ambiguous.
- Cloud billing integration, a public plugin marketplace, distributed workers, and perfect sandboxing are explicitly out of scope for the MVP.
