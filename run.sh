#!/usr/bin/env bash
# Chrome Browser Bridge - Universal Unix Launcher
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "============================================================"
echo "  ⚡ Chrome Browser Bridge Server"
echo "============================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[X] Error: Node.js is not installed or not in PATH."
  echo "    Please install Node.js (v16+) from https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[*] Setting up dependencies (running once)..."
  npm install --silent
  echo "[*] Dependencies ready!"
fi

echo "[*] Starting Bridge Server on http://127.0.0.1:8765..."
node server.js
