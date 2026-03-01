#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_DIR=".autoloop"
PID_FILE="$RUN_DIR/prod.server.pid"
LOG_FILE="$RUN_DIR/prod.server.log"

MODE="${1:-foreground}"
if [[ "$MODE" != "foreground" && "$MODE" != "daemon" && "$MODE" != "stop" ]]; then
  echo "Usage: $0 [daemon|stop]"
  exit 1
fi

if [[ "$MODE" == "stop" ]]; then
  if [[ ! -f "$PID_FILE" ]]; then
    echo "AutoLoop Production server is not running (PID file not found)."
    exit 0
  fi

  existing_pid="$(cat "$PID_FILE")"
  if [[ -z "$existing_pid" ]]; then
    rm -f "$PID_FILE"
    echo "PID file was empty and has been cleaned up."
    exit 0
  fi

  if ! kill -0 "$existing_pid" >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    echo "AutoLoop Production server is not running (stale PID file cleaned)."
    exit 0
  fi

  kill "$existing_pid"
  rm -f "$PID_FILE"
  echo "Stopped AutoLoop Production server (PID: $existing_pid)."
  exit 0
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
    if command -v openssl >/dev/null 2>&1; then
      generated_admin_token="$(openssl rand -hex 24)"
    else
      generated_admin_token="$(bun -e 'const bytes = crypto.getRandomValues(new Uint8Array(24)); console.log(Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""));')"
    fi

    export AUTOLOOP_CONSOLE_ADMIN_TOKEN="$generated_admin_token"
    echo "AUTOLOOP_CONSOLE_ADMIN_TOKEN is empty in .env; generated a temporary token for this run:"
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
