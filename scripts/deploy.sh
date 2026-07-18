#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
PROJECT_NAME="$(basename "$ROOT_DIR")"

printf '\n=== %s deploy ===\n\n' "$PROJECT_NAME"
printf '  [1] Local  — npm run dev (port 3004)\n'
printf '  [2] Cloud  — CodeBuild → ECR → App Runner (scale-to-zero, wake on first ping)\n\n'
printf 'Choice [1/2]: '
read -r DEPLOY_TARGET
case "${DEPLOY_TARGET:-2}" in
  1)
    cd "$ROOT_DIR"
    npm install --prefer-offline || npm install
    exec npm run dev
    ;;
  2) ;;
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
    printf 'New password? [Enter to keep saved]: '
    read -rs NEW_PASS; printf '\n'
    if [[ -n "$NEW_PASS" ]]; then
      CLICKHOUSE_PASSWORD="$NEW_PASS"
      export CLICKHOUSE_PASSWORD
      printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
        "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
      chmod 600 "$CREDS_FILE"
      printf '  Password updated in .clickhouse-creds\n\n'
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

printf '[3/5] Provisioning infrastructure (terraform apply)...\n'
cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null

ECR_IMAGE_EXISTS="$(aws ecr describe-images \
  --repository-name "ch-dash-app" \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)"

if [[ -z "$ECR_IMAGE_EXISTS" || "$ECR_IMAGE_EXISTS" == "None" ]]; then
  printf '  First deploy — provisioning ECR + CodeBuild before building image.\n'
  terraform apply -auto-approve -input=false \
    -target=aws_ecr_repository.app \
    -target=aws_ecr_lifecycle_policy.app \
    -target=aws_s3_bucket.codebuild_src \
    -target=aws_iam_role.codebuild \
    -target=aws_iam_role_policy.codebuild \
    -target=aws_codebuild_project.app \
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

SRC_BUCKET="$(terraform output -raw codebuild_source_bucket)"
CB_PROJECT="$(terraform output -raw codebuild_project_name)"

printf '[4/5] Building, migrating and seeding via CodeBuild...\n'
TMPZIP="/tmp/${PROJECT_NAME}-source.zip"
cd "$ROOT_DIR"
zip -qr "$TMPZIP" . \
  --exclude ".git/*" --exclude "node_modules/*" --exclude ".next/*" \
  --exclude "infra/.terraform/*" --exclude "infra/terraform.tfstate*" \
  --exclude ".env*" --exclude ".clickhouse-creds"
aws s3 cp "$TMPZIP" "s3://${SRC_BUCKET}/source.zip" --quiet
rm -f "$TMPZIP"

BUILD_ID="$(aws codebuild start-build \
  --project-name "$CB_PROJECT" \
  --environment-variables-override \
    name=CLICKHOUSE_URL,value="$CLICKHOUSE_URL",type=PLAINTEXT \
    name=CLICKHOUSE_PASSWORD,value="$CH_PASS",type=PLAINTEXT \
  --query 'build.id' --output text)"
printf '  Build %s started...\n' "$BUILD_ID"

while true; do
  STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)"
  if [[ "$STATUS" == "SUCCEEDED" ]]; then printf '  Build succeeded.\n'; break; fi
  if [[ "$STATUS" == "FAILED" || "$STATUS" == "FAULT" || "$STATUS" == "STOPPED" || "$STATUS" == "TIMED_OUT" ]]; then
    printf 'ERROR: CodeBuild %s. Logs:\n' "$STATUS"
    aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].logs.deepLink' --output text
    exit 1
  fi
  printf '  %s...\n' "$STATUS"
  sleep 20
done

printf '[5/5] Deploying to App Runner...\n'
cd "$INFRA_DIR"
terraform apply -auto-approve -input=false
APP_RUNNER_ARN="$(terraform output -raw apprunner_service_arn)"
CDN_URL="$(terraform output -raw cdn_url)"

[[ "$FIRST_DEPLOY" == "0" ]] && aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null

while true; do
  SVC_STATUS="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
  if [[ "$SVC_STATUS" == "RUNNING" ]]; then printf '  Running.\n'; break; fi
  if [[ "$SVC_STATUS" == "CREATE_FAILED" || "$SVC_STATUS" == "UPDATE_FAILED" ]]; then
    printf 'ERROR: App Runner %s.\n' "$SVC_STATUS"; exit 1; fi
  printf '  %s...\n' "$SVC_STATUS"; sleep 20
done

printf '\n  Dashboard: %s\n' "$CDN_URL"
printf '  Tear down: %s/scripts/infra-down.sh\n\n' "$ROOT_DIR"

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
