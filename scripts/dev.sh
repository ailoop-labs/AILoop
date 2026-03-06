#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  cp ".env.example" ".env"
fi

if [[ ! -d "node_modules" ]]; then
  bun install
fi

if [[ ! -d "web/node_modules" ]]; then
  bun --cwd=web install
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

bun run server &
SERVER_PID=$!

bun run web:dev &
WEB_PID=$!

echo "AILoop Dev is running."
echo "Web Console: http://127.0.0.1:5173"
echo "API Server:  http://127.0.0.1:3090"
echo "Use the web console for start/pause/resume/stop and parameter settings."

wait -n "$SERVER_PID" "$WEB_PID"
