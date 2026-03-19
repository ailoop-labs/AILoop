# Configuration Management

AILoop now treats the workspace database as the only configuration source of truth.

## Source of Truth

- Runtime configuration is stored in `./.ailoop/ailoop.db`.
- Loop runtime settings such as `intervalSeconds`, `maxCycles`, runtime budgets, and evaluator retry limits are stored in the `config` table alongside AI CLI settings.
- `loadConfig()` and the console server read from that database only.
- `.env` and ordinary `AILOOP_*` process environment variables are not used to resolve application configuration.
- The legacy `./.ailoop/runtime-config.json` file is no longer authoritative. If present, it is migrated into the database and removed.
- The workspace home is fixed to `./.ailoop` for the current working directory. `AILOOP_HOME` is no longer an editable config key.

## What Still Uses Process Environment

The process environment is still inherited for non-config purposes such as:

- `PATH` and shell command discovery
- external API credentials used by tools or CLIs
- secret redaction inputs

That is separate from AILoop application configuration.

## Managing Configuration

### Via API

Get all database-backed configuration:

```bash
curl http://localhost:3090/api/base-config
```

Update configuration:

```bash
curl -X POST http://localhost:3090/api/base-config \
  -H "Content-Type: application/json" \
  -d '{
    "AILOOP_AI_CLI_BIN": "/opt/homebrew/bin/claude",
    "AILOOP_BUDGET_USD_PER_ROUND": "1.0"
  }'
```

### Via SQLite

```bash
# View all configuration
sqlite3 .ailoop/ailoop.db "SELECT * FROM config ORDER BY key;"

# Update a specific value
sqlite3 .ailoop/ailoop.db "UPDATE config SET value='1.0' WHERE key='AILOOP_BUDGET_USD_PER_ROUND';"
```

### Via Helper Scripts

Inspect the effective database-backed configuration:

```bash
bun run scripts/test-db-config.ts
```

Remove stale legacy config keys:

```bash
bun run scripts/migrate-config-to-db.ts
```

## Supported Keys

### General Settings

- `AILOOP_INTERVAL_SECONDS`
- `AILOOP_MAX_CYCLES`
- `AILOOP_EXIT_ON_ERROR`
- `AILOOP_MAX_RETAIN_RUNS`

### Budget Settings

- `AILOOP_BUDGET_USD_PER_ROUND`
- `AILOOP_BUDGET_TIME_MINUTES`
- `AILOOP_BUDGET_ACTIONS`

### AI CLI Settings

- `AILOOP_AI_CLI_BIN`
- `AILOOP_AI_CLI_MODEL`
- `AILOOP_AI_CLI_PROFILE`
- `AILOOP_AI_CLI_PLANNER_SANDBOX`
- `AILOOP_AI_CLI_EXECUTOR_SANDBOX`
- `AILOOP_AI_CLI_EVALUATOR_SANDBOX`
- `AILOOP_AI_CLI_TIMEOUT_MS`

Legacy `AILOOP_CODEX_*` keys are exported to loop child processes for compatibility, but they are not stored as authoritative config.

### Evaluator Settings

- `AILOOP_EVAL_REWORK_MAX_ATTEMPTS`
- `AILOOP_LLM_EVALUATOR_DIMENSIONS`
- `AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE`
- `AILOOP_UI_EVALUATOR_CMD`

### Console Settings

- `AILOOP_CONSOLE_HOST`
- `AILOOP_CONSOLE_PORT`
- `AILOOP_CONSOLE_ADMIN_TOKEN`
- `AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE`

## Restart Behavior

After changing base configuration in the database, restart AILoop so the console server and new loop processes pick up the updated values.

```bash
bun run scripts/ailoop.ts stop
bun run scripts/ailoop.ts start
```

## Troubleshooting

Configuration appears stale:

- verify the current working directory is the intended workspace
- inspect `./.ailoop/ailoop.db`
- confirm the `config` table exists: `sqlite3 .ailoop/ailoop.db ".schema config"`

Need to clear a bad key:

```bash
sqlite3 .ailoop/ailoop.db "DELETE FROM config WHERE key='AILOOP_AI_CLI_BIN';"
```
