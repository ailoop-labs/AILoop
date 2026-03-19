# Configuration Storage Summary

AILoop configuration has been fully converged onto the workspace SQLite database at `./.ailoop/ailoop.db`.

## Current State

- `loadConfig()` resolves application settings from the workspace database only.
- Runtime loop settings such as interval, max cycles, runtime budgets, and evaluator retry limits are also stored in the same database-backed `config` table.
- The console server reads admin token metadata from the database instead of process environment.
- Runtime AI CLI settings are stored as `AILOOP_AI_CLI_*` in the database and injected into new loop processes when they start.
- Compatibility `AILOOP_CODEX_*` variables are still exported to child processes, but only as derived compatibility output.
- Legacy `./.ailoop/runtime-config.json` files are migrated away and should no longer be treated as a live config source.
- `AILOOP_HOME` is no longer treated as an editable configuration key.

## Operational Impact

- Editing `.env` does not change AILoop configuration.
- Updating config through `/api/base-config` or direct SQLite writes changes the authoritative source.
- Restart the console server or loop after base-config changes so new processes pick them up.

## Helper Scripts

- `bun run scripts/test-db-config.ts`
  - inspect the current workspace database and resolved runtime config
- `bun run scripts/migrate-config-to-db.ts`
  - remove stale legacy keys such as `AILOOP_HOME` and `AILOOP_CODEX_*`

## Remaining Boundaries

- Process environment is still inherited for non-config concerns such as `PATH`, API credentials consumed by external tools, and secret redaction inputs.
- Historical docs or old test helpers may still mention `AILOOP_HOME` as a conceptual persistence root, but runtime configuration itself is database-backed.
