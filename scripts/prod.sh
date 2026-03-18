#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_DIR=".ailoop"
DB_FILE="$RUN_DIR/ailoop.db"
PID_FILE="$RUN_DIR/prod.server.pid"
LOG_FILE="$RUN_DIR/prod.server.log"
TOKEN_CACHE_FILE="$RUN_DIR/console.admin.token.cache"
START_LOCK_DIR="$RUN_DIR/prod.server.start.lock"
STOP_TIMEOUT_SECONDS="${AILOOP_PROD_STOP_TIMEOUT_SECONDS:-20}"
START_LOCK_WAIT_SECONDS="${AILOOP_PROD_START_LOCK_WAIT_SECONDS:-30}"
STARTUP_TIMEOUT_SECONDS="${AILOOP_PROD_STARTUP_TIMEOUT_SECONDS:-20}"
BUN_BIN="$(command -v bun)"

if [[ -z "$BUN_BIN" ]]; then
  echo "bun is required but was not found in PATH."
  exit 1
fi

db_get_config() {
  local key="$1"
  local fallback="${2:-}"
  NO_COLOR=1 "$BUN_BIN" -e '
    import { Database } from "bun:sqlite";
    const [dbPath, key, fallback] = process.argv.slice(1);
    try {
      const db = new Database(dbPath, { create: true });
      const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value?: string } | null;
      db.close();
      console.log(row?.value ?? fallback ?? "");
    } catch {
      console.log(fallback ?? "");
    }
  ' "$DB_FILE" "$key" "$fallback"
}

db_set_config() {
  local key="$1"
  local value="$2"
  mkdir -p "$RUN_DIR"
  NO_COLOR=1 "$BUN_BIN" -e '
    import { Database } from "bun:sqlite";
    const [dbPath, key, value] = process.argv.slice(1);
    const db = new Database(dbPath, { create: true });
    db.run(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, ?, datetime("now"))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, value]);
    db.close();
  ' "$DB_FILE" "$key" "$value"
}

db_delete_config() {
  local key="$1"
  mkdir -p "$RUN_DIR"
  NO_COLOR=1 "$BUN_BIN" -e '
    import { Database } from "bun:sqlite";
    const [dbPath, key] = process.argv.slice(1);
    const db = new Database(dbPath, { create: true });
    db.run("DELETE FROM config WHERE key = ?", [key]);
    db.close();
  ' "$DB_FILE" "$key"
}

CONSOLE_PORT="$(db_get_config "AILOOP_CONSOLE_PORT" "3090")"

if ! [[ "$STOP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "AILOOP_PROD_STOP_TIMEOUT_SECONDS must be a non-negative integer."
  exit 1
fi

if ! [[ "$START_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "AILOOP_PROD_START_LOCK_WAIT_SECONDS must be a non-negative integer."
  exit 1
fi

if ! [[ "$STARTUP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "AILOOP_PROD_STARTUP_TIMEOUT_SECONDS must be a non-negative integer."
  exit 1
fi

release_start_lock() {
  if [[ ! -d "$START_LOCK_DIR" ]]; then
    return 0
  fi

  local lock_pid=""
  if [[ -f "$START_LOCK_DIR/pid" ]]; then
    read -r lock_pid <"$START_LOCK_DIR/pid" || true
  fi

  if [[ -z "$lock_pid" || "$lock_pid" == "$$" ]]; then
    rm -rf "$START_LOCK_DIR"
  fi
}

acquire_start_lock() {
  mkdir -p "$RUN_DIR"
  local deadline=$((SECONDS + START_LOCK_WAIT_SECONDS))

  while true; do
    if mkdir "$START_LOCK_DIR" 2>/dev/null; then
      printf "%s\n" "$$" >"$START_LOCK_DIR/pid"
      trap release_start_lock EXIT
      return 0
    fi

    local lock_pid=""
    if [[ -f "$START_LOCK_DIR/pid" ]]; then
      read -r lock_pid <"$START_LOCK_DIR/pid" || true
    fi

    if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" >/dev/null 2>&1; then
      rm -rf "$START_LOCK_DIR"
      continue
    fi

    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for the production server startup lock."
      exit 1
    fi

    sleep 0.2
  done
}

wait_for_server_start() {
  local server_pid="$1"
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
      return 1
    fi

    if curl -fsS "http://127.0.0.1:${CONSOLE_PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.2
  done

  return 1
}

graceful_stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "AILoop Production server is not running (PID file not found)."
    return 0
  fi

  local existing_pid
  existing_pid="$(cat "$PID_FILE")"
  if [[ -z "$existing_pid" ]]; then
    rm -f "$PID_FILE"
    echo "PID file was empty and has been cleaned up."
    return 0
  fi

  if ! kill -0 "$existing_pid" >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    echo "AILoop Production server is not running (stale PID file cleaned)."
    return 0
  fi

  echo "Stopping AILoop Production server (PID: $existing_pid)..."
  kill "$existing_pid"
  local deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
  while kill -0 "$existing_pid" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "Graceful stop timed out after ${STOP_TIMEOUT_SECONDS}s; forcing termination."
      kill -KILL "$existing_pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 0.2
  done

  rm -f "$PID_FILE"
  # Clear any stale loop flags/locks to prevent deadlocks on restart
  rm -f "$RUN_DIR/loop.lock" "$RUN_DIR/loop.pid" "$RUN_DIR/loop.pause" "$RUN_DIR/loop.stop"
  echo "Stopped."
}

MODE="${1:-foreground}"
if [[ "$MODE" != "foreground" && "$MODE" != "daemon" && "$MODE" != "stop" && "$MODE" != "restart" ]]; then
  echo "Usage: $0 [foreground|daemon|stop|restart]"
  exit 1
fi

if [[ "$MODE" == "stop" ]]; then
  graceful_stop_server
  exit 0
fi

if [[ "$MODE" == "restart" ]]; then
  echo "Restart requested: stopping current server gracefully."
  graceful_stop_server
  MODE="daemon"
fi

if [[ "$MODE" == "daemon" ]]; then
  acquire_start_lock
  if [[ -f "$PID_FILE" ]]; then
    existing_pid="$(cat "$PID_FILE")"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      echo "AILoop Production server is already running (PID: $existing_pid)."
      echo "Log: $LOG_FILE"
      exit 0
    fi
    rm -f "$PID_FILE"
  fi
fi

if [[ ! -d "node_modules" ]]; then
  bun install
fi

if [[ ! -d "web/node_modules" ]]; then
  bun --cwd=web install
fi

stored_admin_token="$(db_get_config "AILOOP_CONSOLE_ADMIN_TOKEN" "")"
stored_issued_date="$(db_get_config "AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE" "")"
if [[ -z "$stored_admin_token" || -z "$stored_issued_date" ]]; then
  today_utc="$(NO_COLOR=1 "$BUN_BIN" -e 'console.log(new Date().toISOString().split("T")[0])')"
else
  today_utc="$(NO_COLOR=1 "$BUN_BIN" -e 'console.log(new Date().toISOString().split("T")[0])')"
fi

if [[ -z "$stored_admin_token" || -z "$stored_issued_date" ]]; then
  today_epoch="$(NO_COLOR=1 bun -e 'console.log(Math.floor(new Date(process.argv[1] + "T00:00:00Z").getTime() / 1000))' "$today_utc")"
  cached_issued_date=""
  cached_token=""
  issued_date="$today_utc"
  generated_admin_token=""

  if [[ -f "$TOKEN_CACHE_FILE" ]]; then
    read -r cached_issued_date cached_token <"$TOKEN_CACHE_FILE" || true
  fi

  if [[ -n "$cached_issued_date" && -n "$cached_token" ]]; then
    cached_epoch="$(NO_COLOR=1 bun -e 'const t=new Date(process.argv[1]+"T00:00:00Z").getTime(); console.log(Number.isNaN(t) ? "" : Math.floor(t/1000))' "$cached_issued_date" 2>/dev/null || true)"
    if [[ -n "$cached_epoch" ]]; then
      token_age_days=$(( (today_epoch - cached_epoch) / 86400 ))
    else
      token_age_days=999999
    fi
  else
    token_age_days=999999
  fi

  if [[ "$token_age_days" -ge 0 && "$token_age_days" -lt 7 ]]; then
    generated_admin_token="$cached_token"
    issued_date="$cached_issued_date"
    echo "Console admin token missing from database; reusing token issued on ${cached_issued_date} (age: ${token_age_days} days)."
  else
    if command -v openssl >/dev/null 2>&1; then
      generated_admin_token="$(openssl rand -hex 24)"
    else
      generated_admin_token="$(NO_COLOR=1 bun -e 'const bytes = crypto.getRandomValues(new Uint8Array(24)); console.log(Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""));')"
    fi
    mkdir -p "$RUN_DIR"
    printf "%s %s\n" "$today_utc" "$generated_admin_token" >"$TOKEN_CACHE_FILE"
    chmod 600 "$TOKEN_CACHE_FILE" || true
    echo "Console admin token missing from database; generated new token (issued on ${today_utc})."
  fi

  db_set_config "AILOOP_CONSOLE_ADMIN_TOKEN" "$generated_admin_token"
  db_set_config "AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE" "$issued_date"
  token_expiry_date="$(NO_COLOR=1 bun -e 'const d=new Date(process.argv[1]+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+7); console.log(Number.isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0])' "$issued_date" 2>/dev/null || true)"
  if [[ -n "$token_expiry_date" ]]; then
    echo "This token is valid for 7 UTC days (expires on ${token_expiry_date} UTC)."
  else
    echo "This token is valid for 7 UTC days from issuance."
  fi
  echo "${generated_admin_token}"
  echo "(Tip: copy this token and paste it into the web login page.)"
else
  token_age_days="$(
    NO_COLOR=1 "$BUN_BIN" -e '
      const [today, issued] = process.argv.slice(2);
      const todayMs = Date.parse(`${today}T00:00:00.000Z`);
      const issuedMs = Date.parse(`${issued}T00:00:00.000Z`);
      if (Number.isNaN(todayMs) || Number.isNaN(issuedMs)) {
        console.log("999999");
      } else {
        console.log(String(Math.floor((todayMs - issuedMs) / 86400000)));
      }
    ' "$today_utc" "$stored_issued_date"
  )"
  if [[ "$token_age_days" -lt 0 || "$token_age_days" -ge 7 ]]; then
    rm -f "$TOKEN_CACHE_FILE"
    db_delete_config "AILOOP_CONSOLE_ADMIN_TOKEN"
    db_delete_config "AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE"
    exec "$0" "$MODE"
  fi
  token_expiry_date="$(NO_COLOR=1 "$BUN_BIN" -e 'const d=new Date(process.argv[1]+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+7); console.log(Number.isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0])' "$stored_issued_date" 2>/dev/null || true)"
  echo "Using console admin token from database (issued on ${stored_issued_date})."
  if [[ -n "$token_expiry_date" ]]; then
    echo "This token is valid for 7 UTC days (expires on ${token_expiry_date} UTC)."
  else
    echo "This token is valid for 7 UTC days from issuance."
  fi
  echo "${stored_admin_token}"
  echo "(Tip: copy this token and paste it into the web login page.)"
fi

bun run web:build

# Kill any process occupying the configured console port before starting
port_pids=$(lsof -t -i:"${CONSOLE_PORT}" 2>/dev/null || true)
if [[ -n "$port_pids" ]]; then
  echo "Port ${CONSOLE_PORT} is in use. Killing process(es) ($port_pids)..."
  echo "$port_pids" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "AILoop Production server is running at http://127.0.0.1:${CONSOLE_PORT}"
echo "Use the web console for all loop operations and parameter settings."

if [[ "$MODE" == "daemon" ]]; then
  mkdir -p "$RUN_DIR"
  # Use nohup with full environment inheritance from current shell
  nohup bun run src/server.ts >>"$LOG_FILE" 2>&1 < /dev/null &
  server_pid="$!"
  echo "$server_pid" >"$PID_FILE"

  if ! wait_for_server_start "$server_pid"; then
    rm -f "$PID_FILE"
    echo "Production server failed to become healthy on port ${CONSOLE_PORT}. Check ${LOG_FILE}."
    exit 1
  fi

  echo "Started in background daemon mode."
  echo "PID: $server_pid"
  echo "Log: $LOG_FILE"
  echo "Tip: Use 'tail -f $LOG_FILE' to monitor the server."
  exit 0
fi

exec bun run src/server.ts
