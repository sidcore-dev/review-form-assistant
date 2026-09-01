#!/bin/bash
# Stops the local Review Form Assistant server.
#
# Finds whatever node process is listening on the port and stops it, after
# confirming it answers this project's /health endpoint. That way it works
# whether the server was started by the installer or by "npm start", and it
# will not kill an unrelated program that happens to hold the port.

set -uo pipefail
PORT="${PORT:-8787}"

if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Nothing is answering on 127.0.0.1:$PORT. The server is not running."
  read -r -p "Press Return to close." _
  exit 0
fi

PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"

if [ -z "$PIDS" ]; then
  echo "Something is answering on port $PORT but the process could not be identified."
  echo "Stop it from the window it is running in."
  read -r -p "Press Return to close." _
  exit 1
fi

for PID in $PIDS; do
  NAME="$(ps -o comm= -p "$PID" 2>/dev/null || true)"
  case "$NAME" in
    *node*)
      echo "Stopping node process $PID on port $PORT..."
      kill "$PID"
      ;;
    *)
      echo "Skipping process $PID ($NAME): not a node process."
      ;;
  esac
done

sleep 0.7
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Still responding. Stop it from the window it is running in."
else
  echo "Stopped."
fi

read -r -p "Press Return to close." _
