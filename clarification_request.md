# Clarification Request for First Implementation Round

`ARCHITECTURE.md` is present and already provides the MVP architecture contract, so no additional architecture clarification is required for round 1.

Before planning the first implementation task, the remaining missing inputs are the MVP acceptance and sequencing choices below:

1. **Initial implementation slice**
   - Which MVP module should be built first?
   - Suggested options:
     - loop engine + state store skeleton
     - planner/executor/evaluator contracts
     - tool registry + built-in tools
     - control API + status endpoint

2. **Acceptance priority for round 2**
   - What concrete outcome should the next round optimize for?
   - Example formats:
     - "Create TypeScript project skeleton with buildable module stubs"
     - "Implement persisted state store and loop state machine tests"
     - "Implement tool registry and shell/file/http tool adapters"

3. **Verification baseline**
   - Which verification command should be considered the MVP gate once code exists?
   - Suggested options:
     - `bun test`
     - `bun run typecheck`
     - `bun test && bun run typecheck`

4. **Delivery preference**
   - Should the MVP be built top-down (server/control plane first) or bottom-up (engine/contracts first)?

## Resolved Inputs Already Available

The following inputs are already defined and do not need clarification:

- Runtime components and ownership are defined in `ARCHITECTURE.md`.
- Loop states and transitions are defined in `ARCHITECTURE.md`.
- Required artifact layout under `.ailoop/` is defined in `ARCHITECTURE.md`.
- Core contracts for `SubTask`, `ToolResult`, `EvaluationResult`, and `RegisteredTool` are defined in `ARCHITECTURE.md`.
- Default per-round budgets are defined in `README.md` and `ARCHITECTURE.md`.

## Review Point

Please provide the preferred initial implementation slice and concrete success criteria for that slice so the next round can plan one atomic implementation task without guessing.
