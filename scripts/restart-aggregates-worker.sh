#!/usr/bin/env bash
# Restart the detached aggregates outbox worker (stop, then start).
set -euo pipefail
DIR="$(dirname "$0")"

"$DIR/stop-aggregates-worker.sh" || true
sleep 1
"$DIR/start-aggregates-worker.sh"
