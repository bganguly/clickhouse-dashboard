#!/usr/bin/env bash
# infra-down.sh — stop local dev or tear down AWS App Runner stacks
# Usage: ./scripts/infra-down.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
CREDS_FILE="$ROOT_DIR/.clickhouse-creds"
EC2_CREDS_FILE="$ROOT_DIR/.ec2-creds"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

_local_running=0
lsof -ti:3004 >/dev/null 2>&1 && _local_running=1 || true

_aws_deployed=0
[[ -f "$INFRA_DIR/terraform.tfstate" ]] && _aws_deployed=1 || true

_ec2_stack_deployed=0
[[ -f "$INFRA_DIR/terraform.tfstate.d/ec2/terraform.tfstate" ]] && _ec2_stack_deployed=1 || true

_ec2_deployed=0; _EC2_INSTANCE_ID=""; _EC2_SG_ID=""
if [[ -f "$EC2_CREDS_FILE" ]]; then
  _ec2_deployed=1
  _EC2_INSTANCE_ID="$(grep '^EC2_INSTANCE_ID=' "$EC2_CREDS_FILE" 2>/dev/null | cut -d= -f2-)"
  _EC2_SG_ID="$(grep '^EC2_SG_ID=' "$EC2_CREDS_FILE" 2>/dev/null | cut -d= -f2-)"
fi

_warn_cloud_url=""
if (( _ec2_deployed )); then
  _warn_cloud_url="$(grep '^CH_CLOUD_URL_PREV=' "$EC2_CREDS_FILE" 2>/dev/null | cut -d= -f2- || true)"
else
  _ch_cur="$(grep '^CLICKHOUSE_URL=' "$CREDS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  [[ "$_ch_cur" == https://* ]] && _warn_cloud_url="$_ch_cur"
fi

printf '\n=== clickhouse-dashboard teardown ===\n\n'
printf '  [1] Local — stop npm dev process'
(( _local_running )) && printf ' [running]' || printf ' [not detected]'
printf '\n'
printf '  [2] Cloud — App Runner (ch-dash) + ECR ch-dash-app + CDN'
(( _aws_deployed )) && printf ' [deployed]' || printf ' [not deployed]'
printf '\n'
printf '  [3] EC2   — App Runner (ch-dash-ec2) + ECR ch-dash-ec2-app + CDN'
(( _ec2_stack_deployed )) && printf ' [deployed]' || printf ' [not deployed]'
(( _ec2_deployed )) && [[ -n "$_EC2_INSTANCE_ID" ]] && printf ' + ClickHouse %s' "$_EC2_INSTANCE_ID"
printf ' — DATA PERMANENTLY DELETED\n'
printf '  [4] Both  — all AWS stacks + EC2 instance\n'
printf '\nChoice [1/2/3/4, default 2]: '
read -r _MODE

case "$_MODE" in
  1) _TARGET="local" ;;
  3) _TARGET="ec2" ;;
  4) _TARGET="both" ;;
  *) _TARGET="cloud" ;;
esac

if [[ "$_TARGET" == "local" ]]; then
  _pid="$(lsof -ti:3004 2>/dev/null || true)"
  if [[ -n "$_pid" ]]; then
    kill "$_pid" 2>/dev/null && green '  Stopped npm dev on :3004'
  else
    dim '  No process found on :3004.'
  fi
  green 'Done.'
  exit 0
fi

command -v aws       >/dev/null 2>&1 || { red 'aws CLI not found'; exit 1; }
command -v terraform >/dev/null 2>&1 || { red 'terraform not found'; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { red 'AWS credentials not configured — run: aws configure'; exit 1; }
dim "  Credentials: $(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null)"

[[ -f "$CREDS_FILE" ]] && source "$CREDS_FILE"
export TF_VAR_clickhouse_url="${CLICKHOUSE_URL:-placeholder}"
export TF_VAR_clickhouse_password="${CLICKHOUSE_PASSWORD:-placeholder}"

_tf_init() {
  cd "$INFRA_DIR"
  terraform init -input=false -upgrade >/dev/null
}

_get_apprunner_arn() {
  terraform output -raw apprunner_service_arn 2>/dev/null || true
}

_pause_apprunner() {
  local _ARN="$1"
  [[ -z "$_ARN" ]] && return 0
  local _STATUS
  _STATUS="$(aws apprunner describe-service --service-arn "$_ARN" \
    --query 'Service.Status' --output text 2>/dev/null || true)"
  if [[ "$_STATUS" == "RUNNING" ]]; then
    bold "Pausing App Runner before destroy..."
    aws apprunner pause-service --service-arn "$_ARN" --no-cli-pager >/dev/null 2>/dev/null || true
    aws apprunner wait service-updated --service-arn "$_ARN" --no-cli-pager 2>/dev/null || true
    green "  App Runner paused"
  fi
}

_flush_ecr() {
  local _REPO="$1"
  bold "Flushing ECR images from ${_REPO}..."
  local _IDS
  _IDS="$(aws ecr list-images --repository-name "$_REPO" \
    --query 'imageIds[*]' --output json --no-cli-pager 2>/dev/null || echo '[]')"
  if [[ "$_IDS" != "[]" && "$_IDS" != "" ]]; then
    aws ecr batch-delete-image --repository-name "$_REPO" \
      --image-ids "$_IDS" --no-cli-pager >/dev/null 2>/dev/null \
      && green "  ECR images deleted" || dim '  ECR delete skipped'
  else
    dim '  ECR repository already empty'
  fi
}

_terminate_ec2() {
  if [[ -n "$_EC2_INSTANCE_ID" ]]; then
    bold "Terminating EC2 ClickHouse instance..."
    aws ec2 terminate-instances --instance-ids "$_EC2_INSTANCE_ID" --no-cli-pager >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$_EC2_INSTANCE_ID"
    green "  EC2 instance $_EC2_INSTANCE_ID terminated"
  fi
  if [[ -n "$_EC2_SG_ID" ]]; then
    aws ec2 delete-security-group --group-id "$_EC2_SG_ID" --no-cli-pager 2>/dev/null \
      && green "  Security group $_EC2_SG_ID deleted" || dim "  Security group already gone"
  fi
  rm -f "$EC2_CREDS_FILE" "$ROOT_DIR/.clickhouse-creds-ec2"
  green '  .ec2-creds removed'
}

_warn_external() {
  local _warned=0
  if [[ -n "$_warn_cloud_url" ]]; then
    printf '\n'
    printf '\033[33m  WARNING: external services may still be running and incurring costs:\033[0m\n'
    printf '\033[33m    ClickHouse Cloud: %s\033[0m\n' "$_warn_cloud_url"
    _warned=1
  fi
  local _ts_url
  _ts_url="$(grep '^TYPESENSE_URL=' "$ROOT_DIR/.typesense-creds" 2>/dev/null | cut -d= -f2- || true)"
  if [[ -n "$_ts_url" ]]; then
    (( _warned == 0 )) && printf '\n' && printf '\033[33m  WARNING: external services may still be running and incurring costs:\033[0m\n'
    printf '\033[33m    Typesense: %s\033[0m\n' "$_ts_url"
    _warned=1
  fi
  local _redis_url
  _redis_url="$(grep '^REDIS_URL=' "$ROOT_DIR/.redis-creds" 2>/dev/null | cut -d= -f2- || true)"
  if [[ -n "$_redis_url" ]]; then
    (( _warned == 0 )) && printf '\n' && printf '\033[33m  WARNING: external services may still be running and incurring costs:\033[0m\n'
    local _redis_host
    _redis_host="$(printf '%s' "$_redis_url" | sed 's|.*@||;s|:.*||')"
    printf '\033[33m    Redis: %s\033[0m\n' "$_redis_host"
    _warned=1
  fi
}

# ── Cloud stack (default workspace) ──────────────────────────────────────────

_teardown_cloud() {
  _tf_init
  terraform workspace select default >/dev/null 2>&1 || true

  local _ARN
  _ARN="$(_get_apprunner_arn)"
  local _STATUS=""
  [[ -n "$_ARN" ]] && _STATUS="$(aws apprunner describe-service --service-arn "$_ARN" \
    --query 'Service.Status' --output text 2>/dev/null || true)"
  printf '\n  App Runner (ch-dash) status: %s\n' "${_STATUS:-unknown}"
  printf '  [1] Start now  [2] Stop now  [enter] Tear down: '
  read -r _PRE_ACTION
  case "${_PRE_ACTION:-}" in
    1)
      [[ -z "$_ARN" ]] && { red '  App Runner not deployed.'; exit 1; }
      aws apprunner resume-service --service-arn "$_ARN" --no-cli-pager >/dev/null \
        && green '  App Runner resuming.' || red '  Resume failed.'
      exit 0
      ;;
    2)
      [[ -z "$_ARN" ]] && { red '  App Runner not deployed.'; exit 1; }
      aws apprunner pause-service --service-arn "$_ARN" --no-cli-pager >/dev/null \
        && green '  App Runner pausing — no compute charges while paused.' || red '  Pause failed.'
      exit 0
      ;;
  esac

  printf '\n  This will destroy:\n'
  printf '    App Runner service (ch-dash)\n'
  printf '    ECR repository: ch-dash-app\n'
  printf '    CloudFront CDN + S3 maintenance bucket\n'
  printf '\n  Proceed? [Y/n]: '
  read -r _CONFIRM
  [[ "${_CONFIRM:-y}" =~ ^[Yy]$ ]] || { red 'Aborted.'; exit 1; }

  _pause_apprunner "$_ARN"
  _flush_ecr "ch-dash-app"
  bold 'Running terraform destroy (Cloud stack)...'
  terraform destroy -auto-approve -input=false
  rm -f "$CREDS_FILE"
  green '  .clickhouse-creds removed'
  green '\nCloud stack torn down.'
}

# ── EC2 stack (ec2 workspace + EC2 instance) ─────────────────────────────────

_teardown_ec2() {
  if [[ "${_ec2_stack_deployed}" -eq 0 && "${_ec2_deployed}" -eq 0 ]]; then
    red '  No EC2 stack or instance detected.'; exit 1
  fi

  printf '\n  This will destroy:\n'
  (( _ec2_stack_deployed )) && printf '    App Runner service (ch-dash-ec2) + ECR ch-dash-ec2-app + CDN\n'
  (( _ec2_deployed )) && [[ -n "$_EC2_INSTANCE_ID" ]] && \
    printf '    EC2 ClickHouse instance %s — DATA PERMANENTLY DELETED (no backup)\n' "$_EC2_INSTANCE_ID"
  printf '\n  Proceed? [Y/n]: '
  read -r _CONFIRM
  [[ "${_CONFIRM:-y}" =~ ^[Yy]$ ]] || { red 'Aborted.'; exit 1; }

  if (( _ec2_stack_deployed )); then
    _tf_init
    terraform workspace select ec2 >/dev/null 2>&1
    local _EC2_AR_ARN
    _EC2_AR_ARN="$(_get_apprunner_arn)"
    _pause_apprunner "$_EC2_AR_ARN"
    _flush_ecr "ch-dash-ec2-app"
    bold 'Running terraform destroy (EC2 stack)...'
    terraform destroy -auto-approve -input=false
    terraform workspace select default >/dev/null 2>&1 || true
    green '\n  EC2 App Runner stack torn down.'
  fi

  if (( _ec2_deployed )); then
    _terminate_ec2
  fi

  green '\nEC2 stack torn down.'
  printf '  Cloud stack remains running.\n'
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

case "$_TARGET" in
  cloud)
    _teardown_cloud
    _warn_external
    printf '  Redeploy: %s/scripts/deploy.sh\n' "$ROOT_DIR"
    ;;
  ec2)
    _teardown_ec2
    ;;
  both)
    printf '\n  This will destroy ALL stacks:\n'
    printf '    Cloud stack (ch-dash App Runner + ECR + CDN)\n'
    (( _ec2_stack_deployed )) && printf '    EC2 stack (ch-dash-ec2 App Runner + ECR ch-dash-ec2-app + CDN)\n'
    (( _ec2_deployed )) && [[ -n "$_EC2_INSTANCE_ID" ]] && \
      printf '    EC2 ClickHouse instance %s — DATA PERMANENTLY DELETED\n' "$_EC2_INSTANCE_ID"
    printf '\n  Proceed? [Y/n]: '
    read -r _CONFIRM
    [[ "${_CONFIRM:-y}" =~ ^[Yy]$ ]] || { red 'Aborted.'; exit 1; }

    _tf_init

    if (( _ec2_stack_deployed )); then
      terraform workspace select ec2 >/dev/null 2>&1
      local _EC2_AR_ARN
      _EC2_AR_ARN="$(_get_apprunner_arn)"
      _pause_apprunner "$_EC2_AR_ARN"
      _flush_ecr "ch-dash-ec2-app"
      bold 'Running terraform destroy (EC2 stack)...'
      terraform destroy -auto-approve -input=false
      terraform workspace select default >/dev/null 2>&1 || true
    fi

    if (( _ec2_deployed )); then
      _terminate_ec2
    fi

    terraform workspace select default >/dev/null 2>&1 || true
    local _ARN
    _ARN="$(_get_apprunner_arn)"
    _pause_apprunner "$_ARN"
    _flush_ecr "ch-dash-app"
    bold 'Running terraform destroy (Cloud stack)...'
    terraform destroy -auto-approve -input=false
    rm -f "$CREDS_FILE"
    green '  .clickhouse-creds removed'
    green '\nAll stacks torn down.'
    printf '  Redeploy: %s/scripts/deploy.sh\n' "$ROOT_DIR"
    _warn_external
    ;;
esac
