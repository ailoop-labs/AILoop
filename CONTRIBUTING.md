# Contributing to AILoop

Thank you for contributing to AILoop. This repository is built around small, reviewable changes that move the product toward the goals defined in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

AILoop is a goal-driven autonomous loop runner, so contributions should optimize for measurable progress, explicit verification, and a low blast radius. Keep changes atomic, keep evidence concrete, and prefer safe workflows over speed.

## Development Principles

- Work from the current source of truth in `README.md`, `ARCHITECTURE.md`, and any active human instruction.
- Prefer one atomic change per PR or round. Avoid bundling unrelated fixes.
- Verify target state before editing files or changing runtime behavior.
- Capture evidence for every meaningful change: tests, type checks, build output, or a clear command transcript.
- Do not commit secrets, tokens, or private endpoints. The project assumes secret redaction in artifacts, but contributors still need to avoid introducing secrets into source control.
- Do not manually commit, push, restart production, or deploy as part of an autonomous round unless a human explicitly asks for it.

## Setup

### Prerequisites

- [Bun](https://bun.sh/) installed and available on `PATH`
- A local clone of this repository

### Initial Setup

1. Clone the repository and move into the workspace.
2. Create local environment settings:

```bash
cp .env.example .env
```

3. Install root dependencies:

```bash
bun install
```

4. Install web console dependencies:

```bash
bun --cwd=web install
```

The helper scripts also perform these install steps automatically if dependencies are missing.

## Development

Use the development launcher to run both the API server and the web console:

```bash
bun run up:dev
```

This starts:

- the API server on `http://127.0.0.1:3090`
- the web console on `http://127.0.0.1:5173`

You can also run pieces directly when debugging:

```bash
bun run server
bun run web:dev
```

Useful CLI commands for working with the loop engine:

```bash
bun run start
bun run pause
bun run resume
bun run stop
bun run status
bun run watch
bun run ailoop instruct "your instruction here"
bun run ailoop history
bun run ailoop roles generate
```

Project state and run history are stored under `.ailoop/` by default.

## Testing

Run the narrowest verification that proves your change is correct, then add broader checks when the change affects shared behavior.

Common verification commands:

```bash
bun test
bun run typecheck
bun run web:build
```

Guidelines:

- Run `bun test` for code changes that affect existing tests or add new behavior.
- Run `bun run typecheck` for TypeScript changes.
- Run `bun run web:build` when touching the web console.
- If you change scripts, environment handling, or loop orchestration, include the exact command output you used to verify the behavior.

Do not claim success without a concrete verification step.

## Round And Evidence Workflow

AILoop is designed around bounded, observable rounds. Contributions should follow the same model even when you are working manually.

1. Start from one atomic objective.
2. Read the current target state before mutating it.
3. Make the smallest change that advances the objective.
4. Verify the result immediately after the change.
5. Record evidence in your PR description, task summary, or handoff note.

Good evidence includes:

- the commands you ran
- whether they passed or failed
- a short explanation of why those checks are sufficient
- the relevant diff or affected files

If you manually intervene outside the loop to fix code or infrastructure, summarize that intervention in `.ailoop/instructions.json` so future rounds can realign with the actual workspace state.

Do not manually create or claim `.ailoop/runs/*` artifacts in contributor notes. Those are engine-managed outputs.

## Safe Change Guidelines

- Prefer idempotent scripts and narrowly scoped edits.
- Avoid destructive commands such as hard resets or blanket file rewrites unless a human explicitly approves them.
- If a required prerequisite is missing, stop and document the blocker instead of guessing.
- If you hit an infrastructure or tool bug unrelated to the business objective, report it clearly rather than patching around it in unrelated files.
- Keep documentation and implementation consistent. When behavior changes, update the relevant docs in the same change when practical.

## Pull Request Checklist

Before opening a Pull Request, make sure you can answer yes to the following:

- The change is scoped to one clear objective.
- The code or docs align with `README.md` and `ARCHITECTURE.md`.
- You verified the change with concrete commands.
- You did not introduce secrets or private endpoints.
- You documented any tradeoffs, residual risks, or follow-up work.

In the Pull Request description, include:

- what changed
- why the change was needed
- how you verified it
- any risk, rollback, or follow-up notes

Small, well-verified Pull Requests are strongly preferred over large mixed changes.
