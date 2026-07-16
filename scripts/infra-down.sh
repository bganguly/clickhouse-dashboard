#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

printf '\n=== clickhouse-dashboard infra-down ===\n\n'

for dep in terraform; do
  command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found in PATH.\n' "$dep"; exit 1; }
done

CH_ORG_ID="${CLICKHOUSE_ORG_ID:-}"
CH_SERVICE_NAME="${CLICKHOUSE_SERVICE_NAME:-clickhouse-dashboard}"

if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
  printf '[1/2] Pausing ClickHouse Cloud service...\n'

  _ch_api() {
    local method="$1" path="$2"
    shift 2
    curl -fsSL -X "$method" \
      -H "Authorization: Basic $(printf '%s' "$CLICKHOUSE_CLOUD_KEY" | base64)" \
      -H "Content-Type: application/json" \
      "https://api.clickhouse.cloud/v1${path}" "$@"
  }

  if [[ -z "$CH_ORG_ID" ]]; then
    CH_ORG_ID="$(_ch_api GET /organizations | python3 -c "import sys,json;orgs=json.load(sys.stdin).get('result',[]); print(orgs[0]['id'] if orgs else '')" 2>/dev/null || true)"
  fi

  if [[ -n "$CH_ORG_ID" ]]; then
    EXISTING_SERVICE="$(_ch_api GET "/organizations/${CH_ORG_ID}/services" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for s in data.get('result',[]):
    if s.get('name')=='${CH_SERVICE_NAME}':
        print(json.dumps(s))
        break
" 2>/dev/null || true)"

    if [[ -n "$EXISTING_SERVICE" ]]; then
      CH_SERVICE_ID="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null || true)"
      CH_STATE="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('state',''))" 2>/dev/null || true)"

      if [[ "$CH_STATE" == "running" || "$CH_STATE" == "provisioning" ]]; then
        _ch_api PATCH "/organizations/${CH_ORG_ID}/services/${CH_SERVICE_ID}/state" \
          -d '{"command":"stop"}' >/dev/null
        printf '  Service %s paused.\n' "$CH_SERVICE_ID"
      else
        printf '  Service state: %s (no action needed).\n' "$CH_STATE"
      fi
    else
      printf '  No service named "%s" found.\n' "$CH_SERVICE_NAME"
    fi
  else
    printf '  Could not determine ClickHouse org ID — skipping CH pause.\n'
  fi
else
  printf '[1/2] CLICKHOUSE_CLOUD_KEY not set — skipping ClickHouse pause.\n'
fi

printf '[2/2] Destroying EC2 infrastructure (terraform destroy)...\n'
cd "$INFRA_DIR"
SSH_KEY=""
for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
  [[ -f "$(eval echo "$candidate")" ]] && { SSH_KEY="$(eval echo "$candidate")"; break; }
done
[[ -n "$SSH_KEY" ]] && export TF_VAR_ssh_public_key_path="$SSH_KEY"

terraform init -input=false >/dev/null
terraform destroy -auto-approve -input=false

printf '\n  EC2 infrastructure destroyed.\n'
printf '  ClickHouse Cloud service paused (data preserved).\n'
printf '  To bring everything back up: ./scripts/deploy.sh\n\n'
