# Configuration Management

AILoop now supports storing configuration in SQLite database, providing a more flexible and manageable way to handle settings.

## Configuration Priority

Configuration values are loaded in the following priority order:

1. **SQLite Database** (highest priority)
2. **Environment Variables** (fallback)
3. **Default Values** (lowest priority)

This means you can override database settings with environment variables if needed.

## Migration from .env to Database

To migrate your existing `.env` configuration to the database:

```bash
bun run scripts/migrate-config-to-db.ts
```

This will:
- Read all configuration from environment variables
- Store them in the SQLite database at `.ailoop/ailoop.db`
- Preserve all existing settings

## Managing Configuration

### Via API

**Get all base configuration:**
```bash
curl http://localhost:3090/api/base-config
```

**Update configuration:**
```bash
curl -X POST http://localhost:3090/api/base-config \
  -H "Content-Type: application/json" \
  -d '{
    "AILOOP_CODEX_BIN": "/opt/homebrew/bin/claude",
    "AILOOP_BUDGET_USD_PER_ROUND": "1.0"
  }'
```

### Via Database

You can also directly query or update the database:

```bash
# View all configuration
sqlite3 .ailoop/ailoop.db "SELECT * FROM config;"

# Update a specific value
sqlite3 .ailoop/ailoop.db "UPDATE config SET value='/path/to/claude' WHERE key='AILOOP_CODEX_BIN';"
```

### Via Environment Variables

Environment variables still work as a fallback:

```bash
AILOOP_CODEX_BIN=/opt/homebrew/bin/claude bun run scripts/ailoop.ts run
```

## Configuration Keys

All standard AILoop configuration keys are supported:

### General Settings
- `AILOOP_HOME` - Home directory for AILoop data
- `AILOOP_INTERVAL_SECONDS` - Interval between loop iterations
- `AILOOP_MAX_CYCLES` - Maximum number of cycles (0 = unlimited)
- `AILOOP_EXIT_ON_ERROR` - Exit on error (0 or 1)
- `AILOOP_MAX_RETAIN_RUNS` - Maximum number of runs to retain

### Budget Settings
- `AILOOP_BUDGET_USD_PER_ROUND` - USD budget per round
- `AILOOP_BUDGET_TIME_MINUTES` - Time budget in minutes
- `AILOOP_BUDGET_ACTIONS` - Action count budget

### CLI Settings
- `AILOOP_CODEX_BIN` - Path to AI CLI binary (codex, claude, etc.)
- `AILOOP_CODEX_MODEL` - Model to use
- `AILOOP_CODEX_PROFILE` - Profile name
- `AILOOP_CODEX_PLANNER_SANDBOX` - Planner sandbox mode
- `AILOOP_CODEX_EXECUTOR_SANDBOX` - Executor sandbox mode
- `AILOOP_CODEX_EVALUATOR_SANDBOX` - Evaluator sandbox mode
- `AILOOP_CODEX_TIMEOUT_MS` - Timeout in milliseconds

### Evaluator Settings
- `AILOOP_EVAL_REWORK_MAX_ATTEMPTS` - Max rework attempts
- `AILOOP_LLM_EVALUATOR_DIMENSIONS` - Evaluation dimensions (comma-separated)
- `AILOOP_LLM_EVALUATOR_MIN_PASS_SCORE` - Minimum passing score

### Console Settings
- `AILOOP_CONSOLE_HOST` - Console server host
- `AILOOP_CONSOLE_PORT` - Console server port
- `AILOOP_CONSOLE_ADMIN_TOKEN` - Admin authentication token

## Benefits of Database Configuration

1. **Dynamic Updates**: Change configuration without editing files
2. **API Access**: Manage settings via REST API
3. **Audit Trail**: Track when configuration was last updated
4. **Centralized**: All settings in one queryable location
5. **Backward Compatible**: Environment variables still work

## Restart Required

After changing configuration in the database, you must restart AILoop for changes to take effect:

```bash
# Stop the loop
bun run scripts/ailoop.ts stop

# Start again
bun run scripts/ailoop.ts start
```

## Database Schema

The configuration table schema:

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## Troubleshooting

**Configuration not loading from database:**
- Ensure the database file exists at `.ailoop/ailoop.db`
- Check file permissions
- Verify the config table exists: `sqlite3 .ailoop/ailoop.db ".schema config"`

**Want to reset to environment variables:**
- Delete specific keys: `sqlite3 .ailoop/ailoop.db "DELETE FROM config WHERE key='AILOOP_CODEX_BIN';"`
- Or clear all: `sqlite3 .ailoop/ailoop.db "DELETE FROM config;"`

**Verify current configuration:**
```bash
curl http://localhost:3090/api/base-config
```
