#!/usr/bin/env bash
# Stop the detached aggregates outbox worker.
set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE="scripts/aggregates-worker.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "stopped aggregates-worker (pid $PID)"
  else
    echo "no live process for pid ${PID:-<none>}"
  fi
  rm -f "$PIDFILE"
else
  echo "no pidfile (not tracked as running)"
fi

# Safety net: reap any stray worker process not captured by the pidfile.
pkill -f "scripts/aggregates-worker.ts" 2>/dev/null || true
