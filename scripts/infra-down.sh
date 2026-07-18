#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
PROJECT_NAME="$(basename "$ROOT_DIR")"

printf '\n=== %s infra-down ===\n\n' "$PROJECT_NAME"

CREDS_FILE="$ROOT_DIR/.clickhouse-creds"
if [[ -f "$CREDS_FILE" ]]; then source "$CREDS_FILE"; fi

export TF_VAR_clickhouse_url="${CLICKHOUSE_URL:-placeholder}"
export TF_VAR_clickhouse_password="${CLICKHOUSE_PASSWORD:-placeholder}"

printf 'Destroying infrastructure (terraform destroy)...\n'
cd "$INFRA_DIR"
terraform init -input=false >/dev/null
terraform destroy -auto-approve -input=false

printf '\n  Done. To bring it back: %s/scripts/deploy.sh\n\n' "$ROOT_DIR"
