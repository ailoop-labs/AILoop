#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_DIR=".autoloop"
PID_FILE="$RUN_DIR/prod.server.pid"
LOG_FILE="$RUN_DIR/prod.server.log"
DAILY_TOKEN_FILE="$RUN_DIR/console.admin.token.daily"
STOP_TIMEOUT_SECONDS="${AUTOLOOP_PROD_STOP_TIMEOUT_SECONDS:-20}"

if ! [[ "$STOP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "AUTOLOOP_PROD_STOP_TIMEOUT_SECONDS must be a non-negative integer."
  exit 1
fi

graceful_stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "AutoLoop Production server is not running (PID file not found)."
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
    echo "AutoLoop Production server is not running (stale PID file cleaned)."
    return 0
  fi

  kill "$existing_pid"
  local deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
  while kill -0 "$existing_pid" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "Graceful stop timed out after ${STOP_TIMEOUT_SECONDS}s; forcing termination (PID: $existing_pid)."
      kill -KILL "$existing_pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 0.2
  done

  rm -f "$PID_FILE"
  echo "Stopped AutoLoop Production server (PID: $existing_pid)."
}

MODE="${1:-foreground}"
if [[ "$MODE" != "foreground" && "$MODE" != "daemon" && "$MODE" != "stop" && "$MODE" != "restart" ]]; then
  echo "Usage: $0 [daemon|stop|restart]"
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
  mkdir -p "$RUN_DIR"
  if [[ -f "$PID_FILE" ]]; then
    existing_pid="$(cat "$PID_FILE")"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      echo "AutoLoop Production server is already running (PID: $existing_pid)."
      echo "Log: $LOG_FILE"
      exit 0
    fi
    rm -f "$PID_FILE"
  fi
fi

if [[ ! -f ".env" ]]; then
  cp ".env.example" ".env"
fi

if [[ ! -d "node_modules" ]]; then
  bun install
fi

if [[ ! -d "web/node_modules" ]]; then
  bun --cwd=web install
fi

configured_admin_token="$(awk '/^AUTOLOOP_CONSOLE_ADMIN_TOKEN=/{sub(/^AUTOLOOP_CONSOLE_ADMIN_TOKEN=/, "", $0); print; exit}' .env)"
configured_admin_token="${configured_admin_token%$'\r'}"
if [[ -z "${AUTOLOOP_CONSOLE_ADMIN_TOKEN:-}" ]]; then
  if [[ -n "$configured_admin_token" ]]; then
    export AUTOLOOP_CONSOLE_ADMIN_TOKEN="$configured_admin_token"
  else
    today_utc="$(date -u +%Y-%m-%d)"
    cached_day=""
    cached_token=""

    if [[ -f "$DAILY_TOKEN_FILE" ]]; then
      read -r cached_day cached_token <"$DAILY_TOKEN_FILE" || true
    fi

    if [[ -n "$cached_day" && -n "$cached_token" && "$cached_day" == "$today_utc" ]]; then
      generated_admin_token="$cached_token"
      echo "AUTOLOOP_CONSOLE_ADMIN_TOKEN is empty in .env; reusing today's token (${today_utc})."
    else
      if command -v openssl >/dev/null 2>&1; then
        generated_admin_token="$(openssl rand -hex 24)"
      else
        generated_admin_token="$(bun -e 'const bytes = crypto.getRandomValues(new Uint8Array(24)); console.log(Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""));')"
      fi
      mkdir -p "$RUN_DIR"
      printf "%s %s\n" "$today_utc" "$generated_admin_token" >"$DAILY_TOKEN_FILE"
      chmod 600 "$DAILY_TOKEN_FILE" || true
      echo "AUTOLOOP_CONSOLE_ADMIN_TOKEN is empty in .env; generated today's token (${today_utc})."
    fi

    export AUTOLOOP_CONSOLE_ADMIN_TOKEN="$generated_admin_token"
    export AUTOLOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE="$today_utc"
    echo "This token is valid until UTC date changes."
    echo "${AUTOLOOP_CONSOLE_ADMIN_TOKEN}"
    echo "(Tip: copy this token and paste it into the web login page.)"
  fi
fi

bun run web:build

echo "AutoLoop Production server is running at http://127.0.0.1:3090"
echo "Use the web console for all loop operations and parameter settings."

if [[ "$MODE" == "daemon" ]]; then
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid bun run src/server.ts >>"$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup bun run src/server.ts >>"$LOG_FILE" 2>&1 < /dev/null &
  fi
  server_pid="$!"
  echo "$server_pid" >"$PID_FILE"

  echo "Started in daemon mode."
  echo "PID: $server_pid"
  echo "Log: $LOG_FILE"
  exit 0
fi

exec bun run server
