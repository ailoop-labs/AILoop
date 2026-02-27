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
  bun --cwd web install
fi

bun run web:build

echo "AutoLoop Production server is running at http://127.0.0.1:3090"
echo "Use the web console for all loop operations and parameter settings."

exec bun run server
