#!/usr/bin/env bash
# infra-down.sh — stop local dev or tear down AWS App Runner stack
# Usage: ./scripts/infra-down.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
CREDS_FILE="$ROOT_DIR/.clickhouse-creds"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

_local_running=0
lsof -ti:3004 >/dev/null 2>&1 && _local_running=1 || true
_tf_state="$INFRA_DIR/terraform.tfstate"
_aws_deployed=0
[[ -f "$_tf_state" ]] && _aws_deployed=1 || true

printf '\n=== clickhouse-dashboard teardown ===\n\n'
printf '  [1] Local  — stop npm dev process'
(( _local_running )) && printf ' [running]' || printf ' [not detected]'
printf '\n'
printf '  [2] Cloud  — destroy AWS App Runner + ECR + CodeBuild + CDN'
(( _aws_deployed )) && printf ' [deployed]' || printf ' [not deployed]'
printf '\n'
printf '\nChoice [1/2, default 2]: '
read -r _MODE
case "$_MODE" in
  1) _TARGET="local" ;;
  *) _TARGET="cloud" ;;
esac

# ── local ─────────────────────────────────────────────────────────────────────
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

# ── cloud: detect App Runner state ───────────────────────────────────────────
command -v aws       >/dev/null 2>&1 || { red 'aws CLI not found'; exit 1; }
command -v terraform >/dev/null 2>&1 || { red 'terraform not found'; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { red 'AWS credentials not configured — run: aws configure'; exit 1; }

[[ -f "$CREDS_FILE" ]] && source "$CREDS_FILE"
export TF_VAR_clickhouse_url="${CLICKHOUSE_URL:-placeholder}"
export TF_VAR_clickhouse_password="${CLICKHOUSE_PASSWORD:-placeholder}"

cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null
_tf() { terraform output -raw "$1" 2>/dev/null || true; }
APP_RUNNER_ARN=$(_tf apprunner_service_arn)

_svc_status=""
if [[ -n "$APP_RUNNER_ARN" ]]; then
  _svc_status=$(aws apprunner describe-service \
    --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.Status' --output text 2>/dev/null || true)
fi
printf '\n  App Runner status: %s\n' "${_svc_status:-unknown}"
printf '  [1] Start now  [2] Stop now  [3] Suspend schedule  [4] Resume schedule  [enter] Tear down: '
read -r _PRE_ACTION

case "${_PRE_ACTION:-}" in
  1)
    [[ -z "$APP_RUNNER_ARN" ]] && { red '  App Runner not deployed.'; exit 1; }
    aws apprunner resume-service --service-arn "$APP_RUNNER_ARN" --no-cli-pager >/dev/null \
      && green '  App Runner resuming — will be RUNNING shortly.' \
      || red '  Resume failed.'
    exit 0
    ;;
  2)
    [[ -z "$APP_RUNNER_ARN" ]] && { red '  App Runner not deployed.'; exit 1; }
    aws apprunner pause-service --service-arn "$APP_RUNNER_ARN" --no-cli-pager >/dev/null \
      && green '  App Runner pausing — no compute charges while paused.' \
      || red '  Pause failed.'
    exit 0
    ;;
  3|4)
    dim '  No scheduler configured for this project.'
    exit 0
    ;;
esac

# ── tear down ─────────────────────────────────────────────────────────────────
dim "  Credentials: $(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null)"
NAME_PREFIX="${TF_VAR_name_prefix:-njs-dash}"
ECR_REPO_NAME="${NAME_PREFIX}-app"

printf '\n  This will destroy:\n'
printf '    App Runner service\n'
printf '    ECR repository: %s\n' "$ECR_REPO_NAME"
printf '    CodeBuild project + S3 source bucket\n'
printf '    CloudFront CDN + S3 maintenance bucket\n'
printf '\n  Proceed? [Y/n]: '
read -r _CONFIRM
[[ "${_CONFIRM:-y}" =~ ^[Yy]$ ]] || { red 'Aborted.'; exit 1; }

if [[ -n "$APP_RUNNER_ARN" && "$_svc_status" == "RUNNING" ]]; then
  bold 'Pausing App Runner before destroy...'
  aws apprunner pause-service --service-arn "$APP_RUNNER_ARN" --no-cli-pager >/dev/null 2>/dev/null || true
  aws apprunner wait service-updated --service-arn "$APP_RUNNER_ARN" --no-cli-pager 2>/dev/null || true
  green '  App Runner paused'
fi

bold 'Flushing ECR images...'
_ids=$(aws ecr list-images --repository-name "$ECR_REPO_NAME" \
  --query 'imageIds[*]' --output json --no-cli-pager 2>/dev/null || echo '[]')
if [[ "$_ids" != "[]" && "$_ids" != "" ]]; then
  aws ecr batch-delete-image --repository-name "$ECR_REPO_NAME" \
    --image-ids "$_ids" --no-cli-pager >/dev/null 2>/dev/null \
    && green "  ECR images deleted" || dim '  ECR delete skipped'
else
  dim '  ECR repository already empty'
fi

bold 'Running terraform destroy...'
terraform destroy -auto-approve -input=false

rm -f "$CREDS_FILE"
green '  .clickhouse-creds removed'
green '\nAWS infrastructure torn down.'
printf '  Redeploy: ./scripts/deploy.sh\n'
