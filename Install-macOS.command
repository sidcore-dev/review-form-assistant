#!/bin/bash
#
# Review Form Assistant - macOS setup.
#
# Double-click this file. It does everything that can be automated:
#   - checks you have Node 20 or newer
#   - verifies the project passes its own audit and tests
#   - starts the local answer server on 127.0.0.1:8787
#   - opens the setup page so you can paste your API key into a form
#   - reveals the extension folder in Finder and copies brave://extensions
#
# It does NOT install the extension into Brave and does not change any browser
# setting. Chromium does not allow a script to do that, and it should not.
# Two clicks are left for you at the end, printed on screen.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-8787}"
LOG="$DIR/server.log"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mSTOPPED: %s\033[0m\n\n' "$1"; read -r -p "Press Return to close." _; exit 1; }

printf '\n'
bold "Review Form Assistant - setup"
printf 'Project: %s\n\n' "$DIR"

# --- Node ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Get it from https://nodejs.org (choose the LTS build), then run this again."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $(node -v) is too old. This needs Node 20 or newer."
fi
echo "Node $(node -v): ok"

# --- Integrity ----------------------------------------------------------
echo "Running the offline test suite..."
if ! node --test >/tmp/rfa-test.log 2>&1; then
  tail -30 /tmp/rfa-test.log
  fail "Tests failed. Do not install this. See the output above."
fi
echo "Tests: $(grep -m1 '^# pass' /tmp/rfa-test.log | tr -d '#') / $(grep -m1 '^# tests' /tmp/rfa-test.log | tr -d '#')"

echo "Running the permission audit..."
if ! node scripts/audit.mjs >/tmp/rfa-audit.log 2>&1; then
  cat /tmp/rfa-audit.log
  fail "Audit found problems. Do not install this. See the report above."
fi
echo "Audit: passed, 0 findings"

# --- Server -------------------------------------------------------------
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Server already running on port $PORT."
else
  echo "Starting the local server on 127.0.0.1:$PORT..."
  # Load .env if it exists, so an existing key is picked up.
  if [ -f "$DIR/.env" ]; then set -a; . "$DIR/.env"; set +a; fi
  nohup node "$DIR/server.js" >"$LOG" 2>&1 &
  sleep 1.5
  if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    tail -20 "$LOG" || true
    fail "The server did not come up. Log: $LOG"
  fi
  echo "Server running. Log: $LOG"
fi

KEY_STATE="$(curl -fsS "http://127.0.0.1:$PORT/health" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).keyConfigured ? "configured" : "missing"')"

# --- Hand off -----------------------------------------------------------
open "http://127.0.0.1:$PORT/setup"
open -R "$DIR/extension" 2>/dev/null || true
printf 'brave://extensions' | pbcopy 2>/dev/null || true

printf '\n'
bold "Automated part is done."
printf '\n'

if [ "$KEY_STATE" = "missing" ]; then
  printf '  1. The setup page just opened. Paste your OpenAI API key there and save.\n'
else
  printf '  1. API key already configured. The setup page is open if you want to change it.\n'
fi

cat <<'STEPS'
  2. Open a new Brave tab and paste brave://extensions (already on your clipboard).
  3. Turn on Developer mode, top right.
  4. Click Load unpacked, then choose the "extension" folder now showing in Finder.

Steps 2 to 4 cannot be scripted. Brave requires a person to load an unpacked
extension. That restriction is the reason this is safe to hand around.

To stop the server later, double-click Stop-Server.command in this folder.
STEPS

printf '\n'
read -r -p "Press Return to close this window." _
