#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_DIR=".ailoop"
PID_FILE="$RUN_DIR/prod.server.pid"
LOG_FILE="$RUN_DIR/prod.server.log"
TOKEN_CACHE_FILE="$RUN_DIR/console.admin.token.cache"
STOP_TIMEOUT_SECONDS="${AUTOLOOP_PROD_STOP_TIMEOUT_SECONDS:-20}"

if ! [[ "$STOP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "AUTOLOOP_PROD_STOP_TIMEOUT_SECONDS must be a non-negative integer."
  exit 1
fi

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
  echo "Stopped AILoop Production server (PID: $existing_pid)."
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
      echo "AILoop Production server is already running (PID: $existing_pid)."
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
    today_utc="$(NO_COLOR=1 bun -e 'console.log(new Date().toISOString().split("T")[0])')"
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
      echo "AUTOLOOP_CONSOLE_ADMIN_TOKEN is empty in .env; reusing token issued on ${cached_issued_date} (age: ${token_age_days} days)."
    else
      if command -v openssl >/dev/null 2>&1; then
        generated_admin_token="$(openssl rand -hex 24)"
      else
        generated_admin_token="$(NO_COLOR=1 bun -e 'const bytes = crypto.getRandomValues(new Uint8Array(24)); console.log(Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""));')"
      fi
      mkdir -p "$RUN_DIR"
      printf "%s %s\n" "$today_utc" "$generated_admin_token" >"$TOKEN_CACHE_FILE"
      chmod 600 "$TOKEN_CACHE_FILE" || true
      echo "AUTOLOOP_CONSOLE_ADMIN_TOKEN is empty in .env; generated new token (issued on ${today_utc})."
    fi

    export AUTOLOOP_CONSOLE_ADMIN_TOKEN="$generated_admin_token"
    export AUTOLOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE="$issued_date"
    token_expiry_date="$(NO_COLOR=1 bun -e 'const d=new Date(process.argv[1]+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+7); console.log(Number.isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0])' "$issued_date" 2>/dev/null || true)"
    if [[ -n "$token_expiry_date" ]]; then
      echo "This token is valid for 7 UTC days (expires on ${token_expiry_date} UTC)."
    else
      echo "This token is valid for 7 UTC days from issuance."
    fi
    echo "${AUTOLOOP_CONSOLE_ADMIN_TOKEN}"
    echo "(Tip: copy this token and paste it into the web login page.)"
  fi
fi

bun run web:build

# Kill any process occupying port 3090 before starting
port_pids=$(lsof -t -i:3090 2>/dev/null || true)
if [[ -n "$port_pids" ]]; then
  echo "Port 3090 is in use. Killing process(es) ($port_pids)..."
  echo "$port_pids" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "AILoop Production server is running at http://127.0.0.1:3090"
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
