#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

_NAME_PREFIX="ch-dash"

# ── Detect current state ──────────────────────────────────────────────────────
_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${_NAME_PREFIX}-app" \
            "Name=instance-state-name,Values=running,stopped,stopping,starting,pending" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text 2>/dev/null || echo "")
[[ "$_INSTANCE_ID" == "None" ]] && _INSTANCE_ID=""

_INSTANCE_STATE="not deployed"
if [[ -n "$_INSTANCE_ID" ]]; then
  _INSTANCE_STATE=$(aws ec2 describe-instances \
    --instance-ids "$_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text 2>/dev/null || echo "unknown")
fi

_SCHED_STATE=$(aws scheduler get-schedule --name "${_NAME_PREFIX}-app-start" \
  --query 'State' --output text 2>/dev/null || echo "NOT_FOUND")

printf '\n=== clickhouse-dashboard teardown ===\n\n'
printf '  EC2:      %s  [%s]\n' "${_INSTANCE_ID:-not deployed}" "${_INSTANCE_STATE}"
printf '  Schedule: starts 8am · stops 5pm · weekdays Pacific  [%s]\n' "${_SCHED_STATE}"
printf '\n'
printf '  [1] Start EC2 now\n'
printf '  [2] Stop EC2 now\n'
printf '  [3] Suspend schedule (disable 8am/5pm automation)\n'
printf '  [4] Resume schedule\n'
printf '  [enter] Tear down all infrastructure\n'
printf '\nChoice [1/2/3/4 or enter]: '
read -r _ACTION

# ── helper: update EventBridge Scheduler state without losing config ──────────
_set_schedule_state() {
  local name="$1" state="$2"
  local cfg
  cfg=$(aws scheduler get-schedule --name "$name" --output json 2>/dev/null) || {
    printf '  Schedule %s not found — run deploy.sh first.\n' "$name"
    return 1
  }
  local expr tz tgt_json
  expr=$(printf '%s' "$cfg" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['ScheduleExpression'])")
  tz=$(printf '%s' "$cfg" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ScheduleExpressionTimezone','UTC'))")
  tgt_json=$(printf '%s' "$cfg" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d['Target']
print(json.dumps({'Arn':t['Arn'],'RoleArn':t['RoleArn'],'Input':t.get('Input','{}')}))")
  aws scheduler update-schedule --name "$name" \
    --schedule-expression "$expr" \
    --schedule-expression-timezone "$tz" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --target "$tgt_json" \
    --state "$state" \
    --output text >/dev/null
}

case "${_ACTION:-}" in
  1)
    [[ -n "$_INSTANCE_ID" ]] || { printf 'No EC2 instance found — run deploy.sh first.\n'; exit 1; }
    printf 'Starting EC2 %s...\n' "$_INSTANCE_ID"
    aws ec2 start-instances --instance-ids "$_INSTANCE_ID" --output text >/dev/null
    printf 'Instance starting — app will be live in ~30s.\n'
    exit 0
    ;;
  2)
    [[ -n "$_INSTANCE_ID" ]] || { printf 'No EC2 instance found — run deploy.sh first.\n'; exit 1; }
    printf 'Stopping EC2 %s...\n' "$_INSTANCE_ID"
    aws ec2 stop-instances --instance-ids "$_INSTANCE_ID" --output text >/dev/null
    printf 'Instance stopping.\n'
    exit 0
    ;;
  3)
    [[ "$_SCHED_STATE" != "NOT_FOUND" ]] || { printf 'Scheduler jobs not found — run deploy.sh first.\n'; exit 1; }
    [[ "$_SCHED_STATE" != "DISABLED" ]] || { printf 'Schedule already disabled.\n'; exit 0; }
    printf 'Suspending 8am/5pm schedule...\n'
    _set_schedule_state "${_NAME_PREFIX}-app-start" "DISABLED"
    _set_schedule_state "${_NAME_PREFIX}-app-stop"  "DISABLED"
    printf 'Schedule suspended — EC2 will not auto-start or auto-stop.\n'
    exit 0
    ;;
  4)
    [[ "$_SCHED_STATE" != "NOT_FOUND" ]] || { printf 'Scheduler jobs not found — run deploy.sh first.\n'; exit 1; }
    [[ "$_SCHED_STATE" != "ENABLED" ]] || { printf 'Schedule already enabled.\n'; exit 0; }
    printf 'Resuming 8am/5pm schedule...\n'
    _set_schedule_state "${_NAME_PREFIX}-app-start" "ENABLED"
    _set_schedule_state "${_NAME_PREFIX}-app-stop"  "ENABLED"
    printf 'Schedule resumed — EC2 will start at next 8am weekday (Pacific).\n'
    exit 0
    ;;
esac

# ── Tear down ─────────────────────────────────────────────────────────────────
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
