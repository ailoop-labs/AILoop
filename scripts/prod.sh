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

exec bun run server
