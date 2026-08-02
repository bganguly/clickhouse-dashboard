#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
PROJECT_NAME="$(basename "$ROOT_DIR")"


printf 'Enable diagnostic logs? [y/N]: '
read -r _DIAG_CHOICE
_DIAG_LOGS=""
if [[ "${_DIAG_CHOICE:-N}" =~ ^[Yy] ]]; then _DIAG_LOGS="1"; fi

_PREFLIGHT_ARN=""
_PREFLIGHT_CDN=""
_PREFLIGHT_CF=""
_DEFAULT_CHOICE=2

printf '[preflight] Checking AWS credentials... '
if command -v aws >/dev/null 2>&1 && aws sts get-caller-identity >/dev/null 2>&1; then
  printf 'ok\n'
  if [[ -d "$INFRA_DIR" ]]; then
    printf '[preflight] Reading Terraform state... '
    _PREFLIGHT_ARN="$(cd "$INFRA_DIR" && terraform output -raw apprunner_service_arn 2>/dev/null || true)"
    _PREFLIGHT_CDN="$(cd "$INFRA_DIR" && terraform output -raw cdn_url 2>/dev/null || true)"
    _PREFLIGHT_CF="$(cd "$INFRA_DIR" && terraform output -raw cf_distribution_id 2>/dev/null || true)"
    [[ -n "$_PREFLIGHT_ARN" ]] && printf 'ARN found\n' || printf 'empty\n'
  fi
  if [[ -z "$_PREFLIGHT_ARN" ]]; then
    printf '[preflight] Querying App Runner for service ARN... '
    _TMP_ARN="$(aws apprunner list-services \
      --query "ServiceSummaryList[?ServiceName=='ch-dash-app'].ServiceArn | [0]" \
      --output text 2>/dev/null || true)"
    if [[ "$_TMP_ARN" != "None" && -n "$_TMP_ARN" ]]; then
      _PREFLIGHT_ARN="$_TMP_ARN"
      printf 'found\n'
    else
      printf 'not found\n'
    fi
  fi
  if [[ -n "$_PREFLIGHT_ARN" ]]; then
    _LOCAL_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
    printf '[preflight] Checking ECR for current commit (%s)... ' "${_LOCAL_SHA:-unknown}"
    if [[ -n "$_LOCAL_SHA" ]] && aws ecr describe-images --repository-name "ch-dash-app" \
        --image-ids "imageTag=${_LOCAL_SHA}" >/dev/null 2>&1; then
      printf 'built\n'
      _DEFAULT_CHOICE=3
      _OPTION3_LABEL="Quick  — GH build passed · redeploy ${_LOCAL_SHA} to App Runner (skips Terraform/DB)"
    else
      printf 'not built yet\n'
      _DEFAULT_CHOICE=2
      _OPTION3_LABEL="Quick  — (unavailable: GH Actions has not built commit ${_LOCAL_SHA:-HEAD} yet)"
    fi
  fi
else
  printf 'failed\n'
fi

printf '\n=== %s deploy ===\n\n' "$PROJECT_NAME"
printf '  [1] Local  — npm run dev (port 3004)\n'
printf '  [2] Cloud  — GitHub Actions → ECR → App Runner (full: Terraform + DB checks)\n'
printf '  [3] %s\n\n' "${_OPTION3_LABEL:-Quick  — redeploy latest ECR image to App Runner (skips Terraform/DB)}"
printf 'Choice [1/2/3, default %s]: ' "$_DEFAULT_CHOICE"
read -r DEPLOY_TARGET
case "${DEPLOY_TARGET:-$_DEFAULT_CHOICE}" in
  1)
    cd "$ROOT_DIR"
    if [[ -f ".env.local" ]]; then
      grep -v '^NEXT_PUBLIC_DIAG_LOGS=' .env.local > .env.local.tmp && mv .env.local.tmp .env.local
    fi
    [[ -n "$_DIAG_LOGS" ]] && printf 'NEXT_PUBLIC_DIAG_LOGS=%s\n' "$_DIAG_LOGS" >> .env.local
    npm install --prefer-offline || npm install
    exec npm run dev
    ;;
  2) ;;
  3)
    printf '\n[quick] Checking AWS credentials...\n'
    aws sts get-caller-identity >/dev/null
    printf '  OK\n'

    APP_RUNNER_ARN="$_PREFLIGHT_ARN"
    CDN_URL="$_PREFLIGHT_CDN"
    CF_DIST_ID="$_PREFLIGHT_CF"

    if [[ -z "$APP_RUNNER_ARN" ]]; then
      printf '[quick] Terraform state empty — querying App Runner...\n'
      _TMP_ARN="$(aws apprunner list-services \
        --query "ServiceSummaryList[?ServiceName=='ch-dash-app'].ServiceArn | [0]" \
        --output text 2>/dev/null || true)"
      [[ "$_TMP_ARN" != "None" && -n "$_TMP_ARN" ]] && APP_RUNNER_ARN="$_TMP_ARN"
    fi
    [[ -z "$APP_RUNNER_ARN" ]] && { printf 'ERROR: no App Runner ARN found — run a full deploy (option 2) first.\n'; exit 1; }

    if [[ -z "$CDN_URL" ]]; then
      _AR_TMP_URL="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" \
        --query 'Service.ServiceUrl' --output text 2>/dev/null || true)"
      [[ -n "$_AR_TMP_URL" ]] && CDN_URL="https://${_AR_TMP_URL}"
    fi

    printf '[quick] ARN: %s\n' "$APP_RUNNER_ARN"

    if ! aws ecr describe-images --repository-name "ch-dash-app" --image-ids imageTag=latest >/dev/null 2>&1; then
      printf 'ERROR: no latest image in ECR — push to GitHub and wait for Actions build first.\n'; exit 1
    fi

    printf '[quick] Checking App Runner state...\n'
    _PRE_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
    if [[ "$_PRE_STATUS" == "OPERATION_IN_PROGRESS" ]]; then
      printf '  Deployment already in progress — waiting for it to finish before starting ours...\n'
      while [[ "$_PRE_STATUS" == "OPERATION_IN_PROGRESS" ]]; do
        sleep 20
        _PRE_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
        printf '  %s...\n' "$_PRE_STATUS"
      done
    fi
    if [[ "$_PRE_STATUS" != "RUNNING" ]]; then
      printf 'ERROR: App Runner in unexpected state: %s\n' "$_PRE_STATUS"; exit 1
    fi

    printf '[quick] Starting App Runner deployment...\n'
    aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
    while true; do
      SVC_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
      if [[ "$SVC_STATUS" == "RUNNING" ]]; then printf '  Running.\n'; break; fi
      if [[ "$SVC_STATUS" == "UPDATE_FAILED" ]]; then printf 'ERROR: App Runner %s.\n' "$SVC_STATUS"; exit 1; fi
      printf '  %s...\n' "$SVC_STATUS"; sleep 20
    done

    if [[ -n "${CF_DIST_ID:-}" ]]; then
      printf '[quick] Invalidating CloudFront cache...\n'
      aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" \
        --query 'Invalidation.Id' --output text
    fi

    _AR_SVC_URL="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" \
      --query 'Service.ServiceUrl' --output text 2>/dev/null || true)"
    _QUICK_BASE="${CDN_URL}"
    [[ -n "$_AR_SVC_URL" ]] && _QUICK_BASE="https://${_AR_SVC_URL}"
    printf '\n  Dashboard: %s\n' "${CDN_URL:-$_QUICK_BASE}"
    exit 0
    ;;
  *) printf 'Invalid choice.\n'; exit 1 ;;
esac

CREDS_FILE="$ROOT_DIR/.clickhouse-creds"

_prompt_creds() {
  printf 'Do you have an existing ClickHouse Cloud service? [Y/n]: '
  read -r HAS_SVC; HAS_SVC="${HAS_SVC:-Y}"
  if [[ "$HAS_SVC" =~ ^[Yy] ]]; then
    USE_CH_API=0
    printf 'ClickHouse hostname (e.g. abc123.us-east-1.aws.clickhouse.cloud): '
    read -r CH_HOSTNAME
    printf 'ClickHouse password: '
    read -rs CLICKHOUSE_PASSWORD; printf '\n'
    export CLICKHOUSE_URL="https://${CH_HOSTNAME}:8443"
    export CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
    export CLICKHOUSE_PASSWORD
  else
    USE_CH_API=1
    printf 'ClickHouse Cloud API key (key-id:key-secret): '
    read -rs CLICKHOUSE_CLOUD_KEY; printf '\n'
    export CLICKHOUSE_CLOUD_KEY
  fi
  printf 'Save credentials? [Y/n]: '
  read -r SAVE_CREDS; SAVE_CREDS="${SAVE_CREDS:-Y}"
  if [[ "$SAVE_CREDS" =~ ^[Yy] ]]; then
    if [[ "$USE_CH_API" == "1" ]]; then
      printf 'CLICKHOUSE_CLOUD_KEY=%s\n' "$CLICKHOUSE_CLOUD_KEY" > "$CREDS_FILE"
    else
      printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
        "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
    fi
    chmod 600 "$CREDS_FILE"
    printf '  Saved to .clickhouse-creds\n\n'
  fi
}

USE_CH_API=0

if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
  USE_CH_API=1
elif [[ -n "${CLICKHOUSE_URL:-}" && -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
  USE_CH_API=0
elif [[ -f "$CREDS_FILE" ]]; then
  source "$CREDS_FILE"
  if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
    USE_CH_API=1
    printf 'Loaded API key from .clickhouse-creds. Use it? [Y/n]: '
  else
    USE_CH_API=0
    printf 'Loaded saved endpoint: %s. Use it? [Y/n]: ' "${CLICKHOUSE_URL:-}"
  fi
  read -r USE_SAVED; USE_SAVED="${USE_SAVED:-Y}"
  if [[ ! "$USE_SAVED" =~ ^[Yy] ]]; then
    unset CLICKHOUSE_CLOUD_KEY CLICKHOUSE_URL CLICKHOUSE_PASSWORD
    _prompt_creds
  elif [[ "$USE_CH_API" == "0" ]]; then
    if [[ -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
      printf 'ClickHouse password: '
      read -rs CLICKHOUSE_PASSWORD; printf '\n'
      export CLICKHOUSE_PASSWORD
      printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
        "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
      chmod 600 "$CREDS_FILE"
    fi
  fi
else
  _prompt_creds
fi

for dep in aws terraform; do
  command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found.\n' "$dep"; exit 1; }
done

printf '[1/5] Checking AWS credentials...\n'
aws sts get-caller-identity >/dev/null
printf '  OK\n'

_GH_REPO="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null \
  | sed 's|.*github\.com[:/]\(.*\)\.git$|\1|; s|.*github\.com[:/]\(.*\)$|\1|')"
if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" ]]; then
  printf '  Syncing AWS credentials to GitHub Actions secrets (%s)...\n' "$_GH_REPO"
  _AWS_REGION="$(aws configure get region 2>/dev/null || echo "us-east-1")"
  aws configure get aws_access_key_id     | gh secret set AWS_ACCESS_KEY_ID     --repo "$_GH_REPO"
  aws configure get aws_secret_access_key | gh secret set AWS_SECRET_ACCESS_KEY --repo "$_GH_REPO"
  printf '%s' "$_AWS_REGION"              | gh secret set AWS_REGION            --repo "$_GH_REPO"
fi

printf '[2/5] Resolving ClickHouse endpoint...\n'
if [[ "$USE_CH_API" == "1" ]]; then
  CH_ORG_ID="${CLICKHOUSE_ORG_ID:-}"
  CH_SERVICE_NAME="${CLICKHOUSE_SERVICE_NAME:-$PROJECT_NAME}"
  CH_REGION="${CLICKHOUSE_CLOUD_REGION:-aws-us-east-1}"
  CH_TIER="${CLICKHOUSE_CLOUD_TIER:-development}"

  _ch_api() { local m="$1" p="$2"; shift 2
    curl -fsSL -X "$m" -H "Authorization: Basic $(printf '%s' "$CLICKHOUSE_CLOUD_KEY" | base64)" \
      -H "Content-Type: application/json" "https://api.clickhouse.cloud/v1${p}" "$@"; }

  [[ -z "$CH_ORG_ID" ]] && CH_ORG_ID="$(_ch_api GET /organizations | python3 -c \
    "import sys,json;orgs=json.load(sys.stdin).get('result',[]); print(orgs[0]['id'] if orgs else '')" 2>/dev/null || true)"
  [[ -z "$CH_ORG_ID" ]] && { printf 'ERROR: could not determine ClickHouse org ID.\n'; exit 1; }

  EXISTING="$(_ch_api GET "/organizations/${CH_ORG_ID}/services" | python3 -c "
import sys,json
for s in json.load(sys.stdin).get('result',[]):
    if s.get('name')=='${CH_SERVICE_NAME}': print(json.dumps(s)); break
" 2>/dev/null || true)"

  if [[ -z "$EXISTING" ]]; then
    printf '  Creating new ClickHouse Cloud service...\n'
    CREATED="$(_ch_api POST "/organizations/${CH_ORG_ID}/services" \
      -d "{\"name\":\"${CH_SERVICE_NAME}\",\"provider\":\"aws\",\"region\":\"${CH_REGION}\",\"tier\":\"${CH_TIER}\"}")"
    CH_HOST="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['endpoints'][0]['hostname'])" 2>/dev/null)"
    CH_PASS="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['password'])" 2>/dev/null)"
  else
    CH_HOST="$(printf '%s' "$EXISTING" | python3 -c "import sys,json;ep=json.load(sys.stdin).get('endpoints',[]); print(ep[0]['hostname'] if ep else '')" 2>/dev/null)"
    CH_SVC_ID="$(printf '%s' "$EXISTING" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)"
    CH_STATE="$(printf '%s' "$EXISTING" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))" 2>/dev/null)"
    CH_PASS="${CLICKHOUSE_PASSWORD:-}"
    if [[ "$CH_STATE" == "idle" || "$CH_STATE" == "stopped" ]]; then
      printf '  Resuming paused service...\n'
      _ch_api PATCH "/organizations/${CH_ORG_ID}/services/${CH_SVC_ID}/state" -d '{"command":"start"}' >/dev/null
    fi
  fi

  [[ -z "$CH_HOST" ]] && { printf 'ERROR: could not determine ClickHouse host.\n'; exit 1; }
  [[ -z "$CH_PASS" ]] && { printf 'ERROR: CLICKHOUSE_PASSWORD required.\n'; exit 1; }
  CLICKHOUSE_URL="https://${CH_HOST}:8443"
else
  CH_PASS="${CLICKHOUSE_PASSWORD}"
fi

printf '  Endpoint: %s\n' "$CLICKHOUSE_URL"
export TF_VAR_clickhouse_url="$CLICKHOUSE_URL"
export TF_VAR_clickhouse_password="$CH_PASS"

if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" ]]; then
  printf '  Syncing ClickHouse credentials to GitHub Actions secrets...\n'
  printf '%s' "$CLICKHOUSE_URL"             | gh secret set CLICKHOUSE_URL          --repo "$_GH_REPO"
  printf '%s' "${CLICKHOUSE_USER:-default}" | gh secret set CLICKHOUSE_USER         --repo "$_GH_REPO"
  printf '%s' "$CH_PASS"                    | gh secret set CLICKHOUSE_PASSWORD     --repo "$_GH_REPO"
  printf '%s' "${_DIAG_LOGS}"               | gh secret set NEXT_PUBLIC_DIAG_LOGS   --repo "$_GH_REPO"
fi
export TF_VAR_next_public_diag_logs="${_DIAG_LOGS}"

REDIS_CREDS_FILE="$ROOT_DIR/.redis-creds"
if [[ -n "${REDIS_URL:-}" ]]; then
  printf '  Using REDIS_URL from environment.\n'
elif [[ -f "$REDIS_CREDS_FILE" ]]; then
  REDIS_URL="$(grep '^REDIS_URL=' "$REDIS_CREDS_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-)"
  _REDIS_DISPLAY="$(printf '%s' "${REDIS_URL:-}" | sed 's|:\([^:@]*\)@|:***@|')"
  printf '  Loaded Redis URL from .redis-creds: %s. Use it? [Y/n]: ' "$_REDIS_DISPLAY"
  read -r USE_REDIS_SAVED; USE_REDIS_SAVED="${USE_REDIS_SAVED:-Y}"
  if [[ ! "$USE_REDIS_SAVED" =~ ^[Yy] ]]; then
    unset REDIS_URL
  fi
fi
if [[ -z "${REDIS_URL:-}" ]]; then
  printf 'Redis URL (rediss://default:TOKEN@host:6380, or press Enter to skip): '
  read -rs REDIS_URL; printf '\n'
  if [[ -n "$REDIS_URL" ]]; then
    printf 'REDIS_URL=%s\n' "$REDIS_URL" > "$REDIS_CREDS_FILE"
    chmod 600 "$REDIS_CREDS_FILE"
    printf '  Saved to .redis-creds\n'
  fi
fi
export TF_VAR_redis_url="${REDIS_URL:-}"
if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" && -n "${REDIS_URL:-}" ]]; then
  printf '%s' "$REDIS_URL" | gh secret set REDIS_URL --repo "$_GH_REPO"
fi

TS_CREDS_FILE="$ROOT_DIR/.typesense-creds"
if [[ -n "${TYPESENSE_URL:-}" && -n "${TYPESENSE_API_KEY:-}" ]]; then
  printf '  Using Typesense credentials from environment.\n'
elif [[ -f "$TS_CREDS_FILE" ]]; then
  source "$TS_CREDS_FILE"
  printf '  Loaded Typesense URL from .typesense-creds: %s. Use it? [Y/n]: ' "${TYPESENSE_URL:-}"
  read -r USE_TS_SAVED; USE_TS_SAVED="${USE_TS_SAVED:-Y}"
  if [[ ! "$USE_TS_SAVED" =~ ^[Yy] ]]; then
    unset TYPESENSE_URL TYPESENSE_API_KEY
  else
    printf '  Use saved API key? [Y/n]: '
    read -r USE_TS_KEY; USE_TS_KEY="${USE_TS_KEY:-Y}"
    if [[ ! "$USE_TS_KEY" =~ ^[Yy] ]]; then
      printf 'Typesense Admin API Key: '
      read -rs TYPESENSE_API_KEY; printf '\n'
      printf 'TYPESENSE_URL=%s\nTYPESENSE_API_KEY=%s\n' "$TYPESENSE_URL" "$TYPESENSE_API_KEY" > "$TS_CREDS_FILE"
      chmod 600 "$TS_CREDS_FILE"
      printf '  Saved to .typesense-creds\n'
    fi
  fi
fi
if [[ -z "${TYPESENSE_URL:-}" ]]; then
  printf 'Typesense URL (e.g. https://xxx.a1.typesense.net, or press Enter to skip): '
  read -r TYPESENSE_URL; printf '\n'
  if [[ -n "$TYPESENSE_URL" ]]; then
    printf 'Typesense Admin API Key: '
    read -rs TYPESENSE_API_KEY; printf '\n'
    printf 'Save credentials? [Y/n]: '
    read -r SAVE_TS_CREDS; SAVE_TS_CREDS="${SAVE_TS_CREDS:-Y}"
    if [[ "$SAVE_TS_CREDS" =~ ^[Yy] ]]; then
      printf 'TYPESENSE_URL=%s\nTYPESENSE_API_KEY=%s\n' "$TYPESENSE_URL" "$TYPESENSE_API_KEY" > "$TS_CREDS_FILE"
      chmod 600 "$TS_CREDS_FILE"
      printf '  Saved to .typesense-creds\n'
    fi
  fi
fi
export TYPESENSE_URL="${TYPESENSE_URL:-}"
export TYPESENSE_API_KEY="${TYPESENSE_API_KEY:-}"
export TF_VAR_typesense_url="${TYPESENSE_URL:-}"
export TF_VAR_typesense_api_key="${TYPESENSE_API_KEY:-}"
if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" && -n "${TYPESENSE_URL:-}" ]]; then
  printf '%s' "$TYPESENSE_URL"     | gh secret set TYPESENSE_URL     --repo "$_GH_REPO"
  printf '%s' "$TYPESENSE_API_KEY" | gh secret set TYPESENSE_API_KEY --repo "$_GH_REPO"
fi

printf '[3/5] Provisioning infrastructure (terraform apply)...\n'
cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null
printf '  Pruning stale state...\n'

terraform state rm aws_codebuild_project.app                            2>/dev/null || true
terraform state rm aws_iam_role_policy.codebuild                        2>/dev/null || true
terraform state rm aws_iam_role.codebuild                               2>/dev/null || true
terraform state rm aws_s3_bucket.codebuild_src                          2>/dev/null || true

_STATE_FILE="$INFRA_DIR/terraform.tfstate"
if [[ -f "$_STATE_FILE" ]]; then
  python3 -c "
import json
with open('$_STATE_FILE') as f: s = json.load(f)
for k in ('codebuild_source_bucket', 'codebuild_project_name'):
    s.get('outputs', {}).pop(k, None)
with open('$_STATE_FILE', 'w') as f: json.dump(s, f, indent=2)
" 2>/dev/null || true
fi

ECR_IMAGE_EXISTS="$(aws ecr describe-images \
  --repository-name "ch-dash-app" \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)"

if [[ -z "$ECR_IMAGE_EXISTS" || "$ECR_IMAGE_EXISTS" == "None" ]]; then
  printf '  First deploy — provisioning ECR before image build.\n'
  terraform apply -auto-approve -input=false \
    -target=aws_ecr_repository.app \
    -target=aws_ecr_lifecycle_policy.app \
    -target=aws_iam_role.apprunner_ecr \
    -target=aws_iam_role_policy_attachment.apprunner_ecr \
    -target=aws_apprunner_auto_scaling_configuration_version.app \
    -target=aws_s3_bucket.maintenance \
    -target=aws_s3_bucket_public_access_block.maintenance \
    -target=aws_s3_bucket_website_configuration.maintenance \
    -target=aws_s3_bucket_policy.maintenance \
    -target=aws_s3_object.maintenance_html
  FIRST_DEPLOY=1
else
  terraform apply -auto-approve -input=false
  FIRST_DEPLOY=0
fi

printf '[4/5] Verifying image in ECR...\n'
_REMOTE_SHA="$(git -C "$ROOT_DIR" ls-remote origin HEAD 2>/dev/null | cut -c1-7)"
_DEPLOY_TAG="${_REMOTE_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "latest")}"
_ecr_image_exists() {
  aws ecr describe-images --repository-name "ch-dash-app" --image-ids "imageTag=$1" \
    >/dev/null 2>&1
}
printf '  Checking ECR for image %s...\n' "$_DEPLOY_TAG"
if ! _ecr_image_exists "$_DEPLOY_TAG"; then
  if _ecr_image_exists "latest"; then
    _GH_BUILD_ACTIVE=0
    if command -v gh >/dev/null 2>&1 && [[ -n "${_GH_REPO:-}" ]]; then
      _GH_RUN_STATUS="$(gh run list --repo "$_GH_REPO" --limit 5 --json headSha,status \
        --jq ".[] | select((.status == \"in_progress\") or (.status == \"queued\")) | select(.headSha | startswith(\"${_DEPLOY_TAG}\")) | .status" \
        2>/dev/null | head -1 || echo '')"
      [[ -n "$_GH_RUN_STATUS" ]] && _GH_BUILD_ACTIVE=1
    fi
    if [[ "$_GH_BUILD_ACTIVE" -eq 1 ]]; then
      printf '  GH Actions is building %s — not in ECR yet.\n\n' "$_DEPLOY_TAG"
      printf '  [1] Wait for build to complete then continue\n'
      printf '  [2] Exit now and re-run deploy later\n\n'
      printf '  Choice [1/2, default 1]: '
      read -r _GH_WAIT_CHOICE
      if [[ "${_GH_WAIT_CHOICE:-1}" == "2" ]]; then
        printf '  Exiting. Re-run deploy.sh once GH Actions completes.\n'
        exit 0
      fi
      printf '  Polling ECR for %s every 30s (up to 15 min)...\n' "$_DEPLOY_TAG"
      _ecr_elapsed=0
      until _ecr_image_exists "$_DEPLOY_TAG"; do
        if (( _ecr_elapsed >= 900 )); then
          printf '  Timed out. Check Actions: https://github.com/%s/actions\n' "$_GH_REPO"
          exit 1
        fi
        sleep 30; _ecr_elapsed=$(( _ecr_elapsed + 30 ))
        printf '  ...%ds elapsed\n' "$_ecr_elapsed"
      done
      printf '  Image %s now in ECR.\n' "$_DEPLOY_TAG"
    else
      printf '  SHA %s not in ECR (code unchanged since last build) — using latest.\n' "$_DEPLOY_TAG"
      _DEPLOY_TAG=latest
    fi
  else
    printf '  No image in ECR yet — waiting for GitHub Actions build (up to 10 min)...\n'
    _ecr_elapsed=0
    until _ecr_image_exists "latest"; do
      if (( _ecr_elapsed >= 600 )); then
        printf '  Timed out. Check Actions: https://github.com/bganguly/clickhouse-dashboard/actions\n'
        exit 1
      fi
      sleep 15; _ecr_elapsed=$(( _ecr_elapsed + 15 ))
      printf '  ...%ds\n' "$_ecr_elapsed"
    done
    _DEPLOY_TAG=latest
  fi
fi
printf '  Image %s found in ECR.\n' "$_DEPLOY_TAG"
_MANIFEST=$(aws ecr batch-get-image --repository-name "ch-dash-app" \
  --image-ids "imageTag=${_DEPLOY_TAG}" --query 'images[0].imageManifest' \
  --output text 2>/dev/null)
if [[ "$_DEPLOY_TAG" != "latest" ]]; then
  aws ecr put-image --repository-name "ch-dash-app" --image-tag latest \
    --image-manifest "$_MANIFEST" >/dev/null 2>&1 \
    && printf '  Re-tagged %s as latest.\n' "$_DEPLOY_TAG" || true
fi

printf '[5/5] Deploying to App Runner...\n'
cd "$INFRA_DIR"
_AR_ARN="$(terraform output -raw apprunner_service_arn 2>/dev/null || true)"
_TAINTED=0
if [[ -n "$_AR_ARN" ]]; then
  _AR_REGION="$(printf '%s' "$_AR_ARN" | cut -d: -f4)"
  _AR_STATUS="$(aws apprunner describe-service --service-arn "$_AR_ARN" \
    --region "$_AR_REGION" --query 'Service.Status' --output text 2>/dev/null || true)"
  if [[ "$_AR_STATUS" == "CREATE_FAILED" ]]; then
    printf '  App Runner in CREATE_FAILED — tainting for recreation...\n'
    terraform taint aws_apprunner_service.app
    _TAINTED=1
  fi
fi
if [[ "$_TAINTED" -eq 1 ]]; then
  terraform apply -auto-approve -input=false
fi
printf '  Reading Terraform outputs...\n'
APP_RUNNER_ARN="$(terraform output -raw apprunner_service_arn)"
CDN_URL="$(terraform output -raw cdn_url)"

if [[ "$FIRST_DEPLOY" == "0" ]]; then
  _PRE2_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
  if [[ "$_PRE2_STATUS" == "OPERATION_IN_PROGRESS" ]]; then
    printf '  Deployment already in progress — waiting before starting ours...\n'
    while [[ "$_PRE2_STATUS" == "OPERATION_IN_PROGRESS" ]]; do
      sleep 20
      _PRE2_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
      printf '  %s...\n' "$_PRE2_STATUS"
    done
  fi
  aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
fi

while true; do
  SVC_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
  if [[ "$SVC_STATUS" == "RUNNING" ]]; then printf '  Running.\n'; break; fi
  if [[ "$SVC_STATUS" == "CREATE_FAILED" || "$SVC_STATUS" == "UPDATE_FAILED" ]]; then
    printf 'ERROR: App Runner %s.\n' "$SVC_STATUS"; exit 1; fi
  printf '  %s...\n' "$SVC_STATUS"; sleep 20
done

_poll_update_mutation() {
  local t0 elapsed row is_done left failed
  t0=$(date +%s)
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%UPDATE searchText%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for UPDATE mutation to register (%ds)...' $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%UPDATE searchText%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    failed="$(printf '%s' "$row" | cut -f3)"
    if [[ "$is_done" == "1" ]]; then
      [[ -n "$failed" ]] && { printf '\n  ERROR: UPDATE mutation failed on part: %s\n' "$failed"; return 1; }
      printf '\r  done — searchText backfill complete.\n'; return 0
    fi
    elapsed=$(( $(date +%s) - t0 ))
    printf '\r  parts remaining: %s  elapsed: %ds' "${left:-?}" "$elapsed"
    sleep 10
  done
}

_poll_materialize_idx() {
  local t0 elapsed total left row is_done failed
  t0=$(date +%s); total=0
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_search_fulltext%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for mutation to register (%ds)...' $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_search_fulltext%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    failed="$(printf '%s' "$row" | cut -f3)"
    if [[ "$is_done" == "1" ]]; then
      [[ -n "$failed" ]] && { printf '\n  ERROR: mutation failed on part: %s\n' "$failed"; return 1; }
      printf '\r  done — index fully materialized.\n'; return 0
    fi
    [[ $total -eq 0 && "${left:-0}" -gt 0 ]] && total=$left
    elapsed=$(( $(date +%s) - t0 ))
    printf '\r  parts remaining: %s / %s  elapsed: %ds' "${left:-?}" "${total:-?}" "$elapsed"
    sleep 10
  done
}

_poll_ocf_mutation() {
  local t0 elapsed row is_done left failed
  t0=$(date +%s)
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='order_category_facts' AND command LIKE '%UPDATE searchText%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for OCF UPDATE mutation to register (%ds)...' $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='order_category_facts' AND command LIKE '%UPDATE searchText%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    failed="$(printf '%s' "$row" | cut -f3)"
    if [[ "$is_done" == "1" ]]; then
      [[ -n "$failed" ]] && { printf '\n  ERROR: OCF mutation failed on part: %s\n' "$failed"; return 1; }
      printf '\r  done — order_category_facts.searchText backfill complete.\n'; return 0
    fi
    elapsed=$(( $(date +%s) - t0 ))
    printf '\r  parts remaining: %s  elapsed: %ds' "${left:-?}" "$elapsed"
    sleep 10
  done
}

_poll_notes_ngram_idx() {
  local t0 elapsed total left row is_done failed
  t0=$(date +%s); total=0
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_notes_ngram%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for idx_notes_ngram mutation to register (%ds)...' $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_notes_ngram%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    failed="$(printf '%s' "$row" | cut -f3)"
    if [[ "$is_done" == "1" ]]; then
      [[ -n "$failed" ]] && { printf '\n  ERROR: idx_notes_ngram mutation failed on part: %s\n' "$failed"; return 1; }
      printf '\r  done — idx_notes_ngram materialized.\n'; return 0
    fi
    [[ $total -eq 0 && "${left:-0}" -gt 0 ]] && total=$left
    elapsed=$(( $(date +%s) - t0 ))
    printf '\r  parts remaining: %s / %s  elapsed: %ds' "${left:-?}" "${total:-?}" "$elapsed"
    sleep 10
  done
}

_poll_ocf_idx() {
  local t0 elapsed total left row is_done failed
  t0=$(date +%s); total=0
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='order_category_facts' AND command LIKE '%MATERIALIZE INDEX%idx_ocf_search%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for idx_ocf_search mutation to register (%ds)...' $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='order_category_facts' AND command LIKE '%MATERIALIZE INDEX%idx_ocf_search%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    failed="$(printf '%s' "$row" | cut -f3)"
    if [[ "$is_done" == "1" ]]; then
      [[ -n "$failed" ]] && { printf '\n  ERROR: OCF index mutation failed on part: %s\n' "$failed"; return 1; }
      printf '\r  done — idx_ocf_search materialized.\n'; return 0
    fi
    [[ $total -eq 0 && "${left:-0}" -gt 0 ]] && total=$left
    elapsed=$(( $(date +%s) - t0 ))
    printf '\r  parts remaining: %s / %s  elapsed: %ds' "${left:-?}" "${total:-?}" "$elapsed"
    sleep 10
  done
}

printf '[deploy] Checking searchText case...\n'
_SEARCH_FIX="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT if(lower(customerFirstName) != substring(searchText, 1, length(customerFirstName)), 1, 0) FROM orders LIMIT 1" \
  2>/dev/null || echo 0)"
if [[ "${_SEARCH_FIX:-0}" -eq 1 ]]; then
  printf '  Mixed-case searchText detected — submitting UPDATE...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders UPDATE searchText = concat(lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId), if(coalesce(notes, '') = '', '', concat(' ', coalesce(notes, ''))), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE lower(customerFirstName) != substring(searchText, 1, length(customerFirstName))" \
    2>/dev/null || true
  _poll_update_mutation
  printf '  Re-baking S3 dump with corrected data...\n'
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}" CLICKHOUSE_PASSWORD="$CH_PASS" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh"
fi

printf '[deploy] Checking notes content...\n'
_NULL_NOTES="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT countIf(notes IS NULL) FROM orders" \
  2>/dev/null || echo 0)"
if [[ "${_NULL_NOTES:-0}" -gt 0 ]]; then
  printf '  %s rows with NULL notes — backfilling...\n' "$_NULL_NOTES"
  _NOTES_POOL="'please leave at front door ring bell twice','gift wrapping requested include birthday card','fragile items handle with extreme care','corporate bulk order for quarterly offsite event','express shipping required before the conference','leave with building concierge if not home','signature required upon delivery no exceptions','urgent replacement for previously damaged shipment','perishable contents keep refrigerated at all times','eco friendly packaging only no plastic wrap','annual office supply subscription renewal invoice','school supply order for upcoming fall semester','bridal shower gift please include congratulations card','rush order needed before saturday morning delivery','holiday promotional bundle seasonal discount applied','wholesale distributor recurring weekly standing order','loyalty rewards redemption free shipping included','priority processing customer complaint credit applied','temperature sensitive store below forty degrees fahrenheit','military veteran discount applied thank you for service'"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders UPDATE notes = arrayElement([${_NOTES_POOL}], toUInt32(intHash32(orderId) % 20) + 1), searchText = concat(lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId), ' ', arrayElement([${_NOTES_POOL}], toUInt32(intHash32(orderId) % 20) + 1), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE notes IS NULL" \
    2>/dev/null || true
  _poll_update_mutation
fi

printf '[deploy] Checking search index...\n'
_IDX="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT countIf(has(skip_indices, 'idx_search_fulltext')), count() FROM system.parts WHERE table='orders' AND active=1" \
  2>/dev/null || echo '0	1')"
_IDX_PARTS="$(printf '%s' "$_IDX" | cut -f1)"
_TOT_PARTS="$(printf '%s' "$_IDX" | cut -f2)"
if [[ "${_TOT_PARTS:-0}" -gt 0 && "${_IDX_PARTS:-0}" -ne "${_TOT_PARTS}" ]]; then
  printf '  %s / %s parts indexed — materializing...\n' "${_IDX_PARTS:-0}" "${_TOT_PARTS:-?}"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders MATERIALIZE INDEX idx_search_fulltext" 2>/dev/null || true
  _poll_materialize_idx
fi

printf '[deploy] Checking notes ngram index...\n'
_NGRAM_IDX="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT countIf(has(skip_indices, 'idx_notes_ngram')), count() FROM system.parts WHERE table='orders' AND active=1" \
  2>/dev/null || echo '0	1')"
_NGRAM_PARTS="$(printf '%s' "$_NGRAM_IDX" | cut -f1)"
_NGRAM_TOT="$(printf '%s' "$_NGRAM_IDX" | cut -f2)"
if [[ "${_NGRAM_TOT:-0}" -gt 0 && "${_NGRAM_PARTS:-0}" -ne "${_NGRAM_TOT}" ]]; then
  printf '  %s / %s parts indexed — materializing idx_notes_ngram...\n' "${_NGRAM_PARTS:-0}" "${_NGRAM_TOT:-?}"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders MATERIALIZE INDEX idx_notes_ngram" 2>/dev/null || true
  _poll_notes_ngram_idx
fi

printf '[deploy] Checking order_category_facts...\n'
_FACTS_OK="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT if(countIf(searchText != '') > 0, 1, 0) FROM order_category_facts" \
  2>/dev/null || echo 0)"
_FACTS_NOTES_OK="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT countIf(hasToken(searchText, 'conference')) FROM (SELECT searchText FROM order_category_facts LIMIT 500000)" \
  2>/dev/null || echo 0)"
_OCF_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT count() FROM order_category_facts" \
  2>/dev/null || echo 0)"
_ORDERS_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT count() FROM orders" \
  2>/dev/null || echo 0)"
_FACTS_OVERSIZED="$(awk "BEGIN{print (${_OCF_COUNT:-0}+0 > (${_ORDERS_COUNT:-1}+0) * 1.2) ? 1 : 0}")"
_OCF_REBUILT=0
if [[ "${_FACTS_OK:-0}" -eq 0 || "${_FACTS_NOTES_OK:-0}" -eq 0 || "${_FACTS_OVERSIZED:-0}" -eq 1 ]]; then
  if [[ "${_FACTS_OVERSIZED:-0}" -eq 1 ]]; then
    printf '  order_category_facts has %s rows vs %s orders — rebuilding from items array...\n' "${_OCF_COUNT}" "${_ORDERS_COUNT}"
  else
    printf '  Truncating and re-inserting order_category_facts (includes searchText)...\n'
  fi

  printf '  [%s] Truncating chart summary tables...\n' "$(date +'%H:%M:%S')"
  for _SUMMARY_TABLE in daily_summary daily_status_category_summary daily_filter_category_summary daily_customer_category_summary; do
    printf '    %s...' "${_SUMMARY_TABLE}"
    curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=60" \
      --data-binary "TRUNCATE TABLE IF EXISTS ${_SUMMARY_TABLE}" 2>/dev/null || true
    printf ' done\n'
  done

  printf '  [%s] Truncating order_category_facts...\n' "$(date +'%H:%M:%S')"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=60" \
    --data-binary "TRUNCATE TABLE order_category_facts" 2>/dev/null || true
  printf '  OCF rows after TRUNCATE: %s\n' \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM order_category_facts" 2>/dev/null || echo '?')"

  printf '  [%s] Starting OCF INSERT from orders ARRAY JOIN items (~2 h) — progress every 30 s...\n' "$(date +'%H:%M:%S')"
  (
    _CH_URL="${CLICKHOUSE_URL}"
    _CH_PASS="${CH_PASS}"
    while true; do
      sleep 30
      _OCF_NOW="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT count() FROM order_category_facts" 2>/dev/null || echo '?')"
      _PROC="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT round(elapsed,0), read_rows, written_rows FROM system.processes WHERE query LIKE 'INSERT INTO order_category_facts%' LIMIT 1" 2>/dev/null || echo '')"
      if [[ -n "${_PROC}" ]]; then
        printf '  [%s] INSERT running — elapsed=%ss  read=%s  written=%s  |  OCF so far: %s rows\n' \
          "$(date +'%H:%M:%S')" \
          "$(printf '%s' "${_PROC}" | cut -f1)" \
          "$(printf '%s' "${_PROC}" | cut -f2)" \
          "$(printf '%s' "${_PROC}" | cut -f3)" \
          "${_OCF_NOW}"
      else
        printf '  [%s] INSERT no longer in system.processes  |  OCF: %s rows\n' "$(date +'%H:%M:%S')" "${_OCF_NOW}"
      fi
    done
  ) &
  _OCF_PROG_PID=$!

  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "INSERT INTO order_category_facts (orderId, date, placedAt, customerId, regionId, regionCode, status, orderTotal, categoryId, categoryName, totalItems, totalRevenue, searchText) SELECT o.orderId, toDate(o.placedAt), o.placedAt, o.customerId, o.regionId, o.regionCode, o.status, o.total, item.categoryId, item.categoryName, item.quantity, toDecimal64(toFloat64(item.quantity) * toFloat64(item.unitPrice), 2), o.searchText FROM orders AS o ARRAY JOIN o.items AS item WHERE notEmpty(o.items) SETTINGS max_execution_time=7200" \
    2>/dev/null || true

  kill "${_OCF_PROG_PID}" 2>/dev/null || true
  wait "${_OCF_PROG_PID}" 2>/dev/null || true

  _OCF_FINAL="$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
    --data-binary "SELECT count() FROM order_category_facts" 2>/dev/null || echo '?')"
  printf '  [%s] OCF INSERT complete — %s rows\n' "$(date +'%H:%M:%S')" "${_OCF_FINAL}"

  printf '  [%s] Forcing merge of chart summary tables (OPTIMIZE FINAL)...\n' "$(date +'%H:%M:%S')"
  for _SUMMARY_TABLE in daily_summary daily_status_category_summary daily_filter_category_summary daily_customer_category_summary; do
    printf '    [%s] %s...' "$(date +'%H:%M:%S')" "${_SUMMARY_TABLE}"
    curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=300" --max-time 360 \
      --data-binary "OPTIMIZE TABLE IF EXISTS ${_SUMMARY_TABLE} FINAL" 2>/dev/null || true
    _SROW="$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM ${_SUMMARY_TABLE}" 2>/dev/null || echo '?')"
    printf ' done (%s rows)\n' "${_SROW}"
  done
  printf '  [%s] Summary tables merged — fastPath chart queries should now be <100 ms.\n' "$(date +'%H:%M:%S')"
  _OCF_REBUILT=1
fi

printf '[deploy] Checking idx_ocf_search index...\n'
_OCF_IDX="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT countIf(has(skip_indices, 'idx_ocf_search')), count() FROM system.parts WHERE table='order_category_facts' AND active=1" \
  2>/dev/null || echo '0	1')"
_OCF_IDX_PARTS="$(printf '%s' "$_OCF_IDX" | cut -f1)"
_OCF_TOT_PARTS="$(printf '%s' "$_OCF_IDX" | cut -f2)"
if [[ "${_OCF_TOT_PARTS:-0}" -gt 0 && "${_OCF_IDX_PARTS:-0}" -ne "${_OCF_TOT_PARTS}" ]]; then
  printf '  %s / %s parts indexed — materializing idx_ocf_search (~10 min for 50M rows)...\n' "${_OCF_IDX_PARTS:-0}" "${_OCF_TOT_PARTS:-?}"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE order_category_facts MATERIALIZE INDEX idx_ocf_search" 2>/dev/null || true
  _poll_ocf_idx
else
  printf '  idx_ocf_search fully materialized (%s / %s parts) — skipping.\n' "${_OCF_IDX_PARTS:-0}" "${_OCF_TOT_PARTS:-?}"
fi

printf '[deploy] Checking daily_order_count...\n'
curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
  --data-binary "CREATE TABLE IF NOT EXISTS daily_order_count (date Date, regionId UInt32, regionCode LowCardinality(String), orderCount UInt64) ENGINE = SummingMergeTree(orderCount) ORDER BY (date, regionId)" \
  2>/dev/null || true
curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
  --data-binary "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_order_count TO daily_order_count AS SELECT toDate(placedAt) AS date, regionId, regionCode, toUInt64(1) AS orderCount FROM orders" \
  2>/dev/null || true
_DOC_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT sum(orderCount) FROM daily_order_count" \
  2>/dev/null || echo 0)"
if [[ "${_DOC_COUNT:-0}" -eq 0 || "${_OCF_REBUILT:-0}" -eq 1 ]]; then
  printf '  [%s] Backfilling daily_order_count from orders (~30s)...\n' "$(date +'%H:%M:%S')"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=60" \
    --data-binary "TRUNCATE TABLE daily_order_count" 2>/dev/null || true
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=600" --max-time 660 \
    --data-binary "INSERT INTO daily_order_count (date, regionId, regionCode, orderCount) SELECT toDate(placedAt) AS date, regionId, regionCode, toUInt64(1) AS orderCount FROM orders SETTINGS max_execution_time=600" \
    2>/dev/null || true
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=120" \
    --data-binary "OPTIMIZE TABLE daily_order_count FINAL" 2>/dev/null || true
  printf '  [%s] daily_order_count ready: %s orders\n' "$(date +'%H:%M:%S')" \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" --data-binary "SELECT sum(orderCount) FROM daily_order_count" 2>/dev/null || echo '?')"
else
  printf '  daily_order_count has %s orders — skipping.\n' "${_DOC_COUNT}"
fi

printf '[deploy] Checking daily_search_token_summary...\n'
curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
  --data-binary "CREATE TABLE IF NOT EXISTS daily_search_token_summary (token LowCardinality(String), date Date, categoryName LowCardinality(String), orderCount UInt32, orderTotal Float64) ENGINE = MergeTree() ORDER BY (token, date, categoryName)" \
  2>/dev/null || true
_DSTS_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT count() FROM daily_search_token_summary" \
  2>/dev/null || echo 0)"
if [[ "${_DSTS_COUNT:-0}" -eq 0 || "${_OCF_REBUILT:-0}" -eq 1 ]]; then
  printf '  [%s] Populating daily_search_token_summary from order_category_facts (~30 min)...\n' "$(date +'%H:%M:%S')"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=60" \
    --data-binary "TRUNCATE TABLE daily_search_token_summary" 2>/dev/null || true
  (
    _CH_URL="${CLICKHOUSE_URL}"
    _CH_PASS="${CH_PASS}"
    while true; do
      sleep 30
      _DSTS_NOW="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT count() FROM daily_search_token_summary" 2>/dev/null || echo '?')"
      _PROC="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT round(elapsed,0), read_rows, written_rows FROM system.processes WHERE query LIKE 'INSERT INTO daily_search_token_summary%' LIMIT 1" 2>/dev/null || echo '')"
      if [[ -n "${_PROC}" ]]; then
        printf '  [%s] token INSERT running — elapsed=%ss  read=%s  written=%s  |  rows so far: %s\n' \
          "$(date +'%H:%M:%S')" \
          "$(printf '%s' "${_PROC}" | cut -f1)" \
          "$(printf '%s' "${_PROC}" | cut -f2)" \
          "$(printf '%s' "${_PROC}" | cut -f3)" \
          "${_DSTS_NOW}"
      else
        printf '  [%s] token INSERT no longer in system.processes  |  rows: %s\n' "$(date +'%H:%M:%S')" "${_DSTS_NOW}"
      fi
    done
  ) &
  _DSTS_PROG_PID=$!

  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "INSERT INTO daily_search_token_summary (token, date, categoryName, orderCount, orderTotal) SELECT tok AS token, date, categoryName, count() AS orderCount, sum(toFloat64(totalRevenue)) AS orderTotal FROM order_category_facts ARRAY JOIN splitByNonAlpha(lower(searchText)) AS tok WHERE length(tok) >= 2 GROUP BY tok, date, categoryName SETTINGS max_execution_time=7200" \
    2>/dev/null || true

  kill "${_DSTS_PROG_PID}" 2>/dev/null || true
  wait "${_DSTS_PROG_PID}" 2>/dev/null || true

  printf '  [%s] daily_search_token_summary populated: %s rows\n' "$(date +'%H:%M:%S')" \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" --data-binary "SELECT count() FROM daily_search_token_summary" 2>/dev/null || echo '?')"
else
  printf '  daily_search_token_summary has %s rows — skipping.\n' "${_DSTS_COUNT}"
fi

_ITEMS_MIGRATION_PENDING=0
printf '[deploy] Checking items column on orders...\n'
_ITEMS_POPULATED="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=60" \
  --data-binary "SELECT countIf(notEmpty(items)) FROM (SELECT items FROM orders LIMIT 1000000)" \
  2>/dev/null || echo 0)"
if [[ "${_ITEMS_POPULATED:-0}" -eq 0 ]]; then
  printf '  items column empty — submitting background migration (~2 h for 50M rows)...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "ALTER TABLE orders ADD COLUMN IF NOT EXISTS items Array(Tuple(categoryId UInt32, categoryName LowCardinality(String), productId UInt32, productName String, productSku LowCardinality(String), quantity UInt32, unitPrice Float64, discount Float64)) DEFAULT []" \
    2>/dev/null || true
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0&max_execution_time=30" \
    --data-binary "ALTER TABLE orders UPDATE items = [tuple(toUInt32(intHash32(toUInt32(orderId) * 3) % 200) + 1, concat('Category ', toString(toUInt32(intHash32(toUInt32(orderId) * 3) % 200) + 1)), toUInt32(intHash32(toUInt32(orderId) * 7) % 5000) + 1, concat('Product ', toString(toUInt32(intHash32(toUInt32(orderId) * 7) % 5000) + 1)), concat('SKU-', toString(toUInt32(intHash32(toUInt32(orderId) * 7) % 5000) + 1)), toUInt32(intHash32(toUInt32(orderId) * 11) % 3) + 1, 5.0 + toFloat64(intHash32(toUInt32(orderId) * 13)) / 4294967295.0 * 100.0, toFloat64(0))] WHERE empty(items)" \
    2>/dev/null || true
  printf '  mutation submitted (non-blocking).\n'
  _ITEMS_MIGRATION_PENDING=1
fi

printf '[deploy] Checking search_vocabulary...\n'
_VOCAB_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT count() FROM search_vocabulary" \
  2>/dev/null || echo 0)"
if [[ "${_VOCAB_COUNT:-0}" -eq 0 ]]; then
  printf '  Populating search_vocabulary from orders.searchText...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "INSERT INTO search_vocabulary (token, doc_freq) SELECT token, count() AS doc_freq FROM (SELECT arrayJoin(splitByNonAlpha(lower(searchText))) AS token FROM orders) WHERE length(token) >= 2 AND NOT match(token, '^[0-9]+\$') GROUP BY token HAVING doc_freq >= 10" \
    2>/dev/null || true
  printf '  search_vocabulary populated: %s tokens\n' \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" --data-binary "SELECT count() FROM search_vocabulary" 2>/dev/null || echo '?')"
fi

if [[ -n "${TYPESENSE_URL:-}" && -n "${TYPESENSE_API_KEY:-}" ]]; then
  printf '[deploy] Checking Typesense collection...\n'
  _TS_COL="$(curl -sf -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
    "${TYPESENSE_URL}/collections/vocabulary" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('num_documents',0))" 2>/dev/null || echo '')"
  if [[ -z "$_TS_COL" ]]; then
    printf '  Creating vocabulary collection...\n'
    curl -sf -X POST "${TYPESENSE_URL}/collections" \
      -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
      -H "Content-Type: application/json" \
      -d '{"name":"vocabulary","fields":[{"name":"id","type":"string"},{"name":"token","type":"string"},{"name":"doc_freq","type":"int32"}]}' \
      >/dev/null 2>&1 || true
    _TS_COL=0
  fi
  printf '  Typesense vocabulary collection: %s tokens\n' "${_TS_COL:-0}"
  _TS_SEED_NEEDED=0
  if [[ "${_TS_COL:-0}" -lt 1000 ]]; then
    _TS_SEED_NEEDED=1
  fi
  if [[ "$_TS_SEED_NEEDED" -eq 1 ]]; then
    printf '  Seeding Typesense vocabulary from search_vocabulary...\n'
    _SEED_FILE="${ROOT_DIR}/.ts_seed.jsonl"
    curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=120" \
      --data-binary "SELECT token AS id, token, toInt32(doc_freq) AS doc_freq FROM search_vocabulary FORMAT JSONEachRow" \
      > "$_SEED_FILE" 2>/dev/null || true
    if [[ -s "$_SEED_FILE" ]]; then
      _TS_IMPORT_RESP="$(curl -sf -X POST "${TYPESENSE_URL}/collections/vocabulary/documents/import?action=upsert" \
        -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
        -H "Content-Type: text/plain" \
        --data-binary "@${_SEED_FILE}" 2>/dev/null | tail -1 || echo '')"
      _TS_COUNT="$(curl -sf -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
        "${TYPESENSE_URL}/collections/vocabulary" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('num_documents',0))" 2>/dev/null || echo '?')"
      printf '  Seeding complete — %s tokens indexed\n' "${_TS_COUNT}"
    else
      printf '  Seed skipped (search_vocabulary empty — run deploy again after vocab is populated).\n'
    fi
    rm -f "$_SEED_FILE"
  else
    printf '  Typesense vocabulary already seeded — skipping.\n'
  fi
fi

CF_DIST_ID="$(terraform output -raw cf_distribution_id 2>/dev/null || true)"
if [[ -n "$CF_DIST_ID" ]]; then
  printf '  Invalidating CloudFront cache...\n'
  aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" \
    --query 'Invalidation.Id' --output text
fi

printf '\n  Dashboard: %s\n' "$CDN_URL"
printf '  Tear down: %s/scripts/infra-down.sh\n' "$ROOT_DIR"

if [[ "$_OCF_REBUILT" -eq 1 ]]; then
  printf '\n  ── OCF rebuilt from items array ──────────────────────────────────────\n'
  printf '  order_category_facts now has 1 row per order (~50 M). Verify:\n\n'
  printf '    SELECT count() FROM order_category_facts;\n'
  printf '    -- Expected: ~50 M  (was ~150 M when built from order_items)\n\n'
  printf '    SELECT count(), categoryName\n'
  printf '    FROM order_category_facts\n'
  printf '    WHERE hasToken(searchText, '"'"'exceptions'"'"')\n'
  printf '    GROUP BY categoryName\n'
  printf '    ORDER BY count() DESC\n'
  printf '    LIMIT 5;\n'
  printf '    -- Should return results in < 2 s (was ~5 s before rebuild).\n'
  printf '  ──────────────────────────────────────────────────────────────────────\n'
fi

if [[ "$_ITEMS_MIGRATION_PENDING" -eq 1 ]]; then
  printf '\n  ── Background migration in progress ──────────────────────────────────\n'
  printf '  orders.items backfill is running (~2 h). Run this SQL to monitor:\n\n'
  printf '    SELECT is_done,\n'
  printf '           parts_to_do          AS parts_left,\n'
  printf '           latest_fail_reason   AS last_error\n'
  printf '    FROM system.mutations\n'
  printf '    WHERE table = '"'"'orders'"'"'\n'
  printf '      AND command LIKE '"'"'%%UPDATE items%%'"'"'\n'
  printf '    ORDER BY create_time DESC\n'
  printf '    LIMIT 1;\n\n'
  printf '  Chart queries for partial-match terms (except, conferenc) will return\n'
  printf '  empty until is_done = 1. Whole-token searches (cassin, etc.) are\n'
  printf '  unaffected — they hit OCF directly.\n'
  printf '  ──────────────────────────────────────────────────────────────────────\n'
fi
printf '\n'

if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" ]]; then
  printf '%s' "$CDN_URL" | gh secret set APP_URL --repo "$_GH_REPO"
  printf '  [keepalive] APP_URL secret updated → %s\n' "$CDN_URL"
fi

if [[ -f "$ROOT_DIR/README.md" ]]; then
  python3 - "$CDN_URL" "$ROOT_DIR/README.md" <<'PYEOF'
import re, sys
url, path = sys.argv[1], sys.argv[2]
content = open(path).read()
content = re.sub(r'(\| \*\*Dashboard\*\* \| )(https?://\S+)( \|)', r'\g<1>' + url + r'\g<3>', content)
open(path, 'w').write(content)
PYEOF
  git -C "$ROOT_DIR" add README.md
  if ! git -C "$ROOT_DIR" diff --cached --quiet; then
    git -C "$ROOT_DIR" commit -m "deploy: update live URL → ${CDN_URL}" && git -C "$ROOT_DIR" push origin HEAD:main
  fi
fi

PORTFOLIO_SCRIPT="$ROOT_DIR/../../portfolio/scripts/set-live-url.sh"
[[ -x "$PORTFOLIO_SCRIPT" ]] && bash "$PORTFOLIO_SCRIPT" clickhouse "$CDN_URL"
