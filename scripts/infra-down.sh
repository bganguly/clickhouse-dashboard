#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
START_TS="$(date +%s)"

elapsed() { local now; now="$(date +%s)"; printf '%ss' "$((now - START_TS))"; }
step()    { printf '\n[%s] %s\n    ETA: %s\n' "$(elapsed)" "$1" "$2"; }

# ── Detect independent workspace state ───────────────────────────────────────
_local_running=0
_lite_count=0
_full_count=0

if lsof -ti:3004 >/dev/null 2>&1 || [[ -f "$ROOT_DIR/scripts/aggregates-worker.pid" ]]; then
  _local_running=1
fi

_tf_ws_count() {
  local state_file="$INFRA_DIR/terraform.tfstate.d/$1/terraform.tfstate"
  [[ -f "$state_file" ]] || { printf '0'; return; }
  python3 -c "import json; d=json.load(open('$state_file')); print(sum(len(r.get('instances',[])) for r in d.get('resources',[])))" 2>/dev/null || printf '0'
}
_lite_count=$(_tf_ws_count lite)
_full_count=$(_tf_ws_count full)

# ── Show menu with detected state ────────────────────────────────────────────
printf '\n=== nextjs-dashboard teardown ===\n\n'
printf '  [1] Local  — stop local dev server'
(( _local_running )) && printf ' [running]' || printf ' [not detected]'
printf '\n'
printf '  [2] Lite   — destroy AWS lite (EC2 t3.micro + RDS db.t3.micro)'
(( _lite_count > 0 )) && printf ' [%s resources active]' "$_lite_count" || printf ' [not deployed]'
printf '\n'
printf '  [3] Full   — destroy AWS full (EC2 t3.small + RDS db.t3.large)'
(( _full_count > 0 )) && printf ' [%s resources active]' "$_full_count" || printf ' [not deployed]'
printf '\n'
printf '\nChoice [1/2/3]: '
read -r _MODE
case "$_MODE" in
  2) _TARGET="remote"; _WORKSPACE="lite" ;;
  3) _TARGET="remote"; _WORKSPACE="full" ;;
  *) _TARGET="local"  ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# LOCAL
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$_TARGET" == "local" ]]; then
  if lsof -ti:3004 >/dev/null 2>&1; then
    printf '\nStopping Next.js on :3004...\n'
    kill "$(lsof -ti:3004)" 2>/dev/null || true
  fi
  "$ROOT_DIR/scripts/stop-aggregates-worker.sh" 2>/dev/null || true
  printf 'Local processes stopped.\n'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# REMOTE (AWS)
# ══════════════════════════════════════════════════════════════════════════════
_WORKSPACE="${_WORKSPACE:-full}"
case "$_WORKSPACE" in
  lite) NAME_PREFIX="dash-lite" ;;
  *)    NAME_PREFIX="dash-full" ;;
esac
DB_INSTANCE_ID="${NAME_PREFIX}-db"
DB_SUBNET_GROUP="${NAME_PREFIX}-subnet-group"

_ws_count_var="_${_WORKSPACE}_count"
if (( ${!_ws_count_var} == 0 )); then
  printf '\nNo Terraform state found for workspace "%s" — nothing to destroy.\n' "$_WORKSPACE"
  exit 0
fi

step "1/4 Checking dependencies: terraform and aws CLI." "< 1 min"
"$ROOT_DIR/scripts/bootstrap-deps.sh" terraform aws

cd "$INFRA_DIR"

if [[ -z "${TF_VAR_ssh_public_key_path:-}" ]]; then
  for _candidate in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub ~/.ssh/id_ecdsa.pub; do
    if [[ -f "$(eval echo "$_candidate")" ]]; then
      export TF_VAR_ssh_public_key_path="$_candidate"
      break
    fi
  done
  if [[ -z "${TF_VAR_ssh_public_key_path:-}" ]]; then
    _tmp_key="$(mktemp)"
    ssh-keygen -t ed25519 -N "" -f "$_tmp_key" -q
    export TF_VAR_ssh_public_key_path="${_tmp_key}.pub"
    _cleanup_tmp_key=1
  fi
fi

step "2/4 Initializing Terraform." "< 1 min"
terraform init -input=false
terraform workspace select "$_WORKSPACE" 2>/dev/null \
  || terraform workspace new "$_WORKSPACE" 2>/dev/null \
  || terraform workspace select "$_WORKSPACE"
printf '    workspace: %s\n' "$_WORKSPACE"

step "3/4 Destroying AWS infra: EC2, RDS, VPC, networking." "5-10 min when resources exist; < 2 min if already absent"
terraform destroy -auto-approve

[[ -n "${_cleanup_tmp_key:-}" ]] && rm -f "$_tmp_key" "${_tmp_key}.pub" || true

step "4/4 Clearing any residual RDS resources outside Terraform state." "5-10 min only if stale RDS instance exists"
_rds_status="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || true)"
if [[ -n "$_rds_status" && "$_rds_status" != "None" ]]; then
  if [[ "$_rds_status" != "deleting" ]]; then
    echo "Deleting residual RDS instance $DB_INSTANCE_ID (status: $_rds_status)."
    aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" \
      --skip-final-snapshot --delete-automated-backups >/dev/null
  fi
  echo "Waiting for $DB_INSTANCE_ID to be deleted..."
  aws rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID"
fi

if aws rds describe-db-subnet-groups --db-subnet-group-name "$DB_SUBNET_GROUP" >/dev/null 2>&1; then
  echo "Deleting residual RDS subnet group $DB_SUBNET_GROUP."
  aws rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP"
fi

rm -f "$ROOT_DIR/.env.rds"
printf '\n[%s] AWS infra destroyed; .env.rds removed (billing stopped).\n' "$(elapsed)"

QUICKORDER_DIR="$(cd "$ROOT_DIR/../websockets-quickorder" 2>/dev/null && pwd || true)"
QUICKORDER_DOWN="${QUICKORDER_DIR}/scripts/infra-down.sh"
if [[ -f "$QUICKORDER_DOWN" ]]; then
  printf '\n  Chaining Quick Order (%s) teardown...\n' "$_WORKSPACE"
  DEPLOY_MODE="$_WORKSPACE" bash "$QUICKORDER_DOWN"
fi

PORTFOLIO_SET_LIVE="$(cd "$ROOT_DIR/../../portfolio/scripts" 2>/dev/null && pwd || true)/set-live-url.sh"
if [[ -f "$PORTFOLIO_SET_LIVE" ]]; then
  printf '\n  Marking nextjs/%s offline in portfolio...\n' "$_WORKSPACE"
  bash "$PORTFOLIO_SET_LIVE" --down --tier "$_WORKSPACE" nextjs
fi
