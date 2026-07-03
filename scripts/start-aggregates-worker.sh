#!/usr/bin/env bash
# Start the aggregates outbox worker detached (survives the shell closing).
# No-op if it's already running.
set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE="scripts/aggregates-worker.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "already running (pid $PID)"
    exit 0
  fi
fi

RUNNER="npx tsx"
if [ -x node_modules/.bin/tsx ]; then
  RUNNER="node_modules/.bin/tsx"
fi

nohup $RUNNER scripts/aggregates-worker.ts > aggregates-worker.log 2>&1 &
NEWPID=$!
echo "$NEWPID" > "$PIDFILE"
echo "started aggregates-worker (pid $NEWPID) -> aggregates-worker.log"
