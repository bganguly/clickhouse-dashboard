#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
PROJECT_NAME="$(basename "$ROOT_DIR")"

printf '\n=== %s deploy ===\n\n' "$PROJECT_NAME"

CREDS_FILE="$ROOT_DIR/.clickhouse-creds"

_prompt_creds() {
  printf 'Do you have an existing ClickHouse Cloud service? [Y/n]: '
  read -r HAS_SVC
  HAS_SVC="${HAS_SVC:-Y}"
  if [[ "$HAS_SVC" =~ ^[Yy] ]]; then
    USE_CH_API=0
    printf 'ClickHouse hostname (e.g. abc123.us-east-1.aws.clickhouse.cloud): '
    read -r CH_HOSTNAME
    printf 'ClickHouse password: '
    read -rs CLICKHOUSE_PASSWORD
    printf '\n'
    export CLICKHOUSE_URL="https://${CH_HOSTNAME}:8443"
    export CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
    export CLICKHOUSE_PASSWORD
  else
    USE_CH_API=1
    printf 'ClickHouse Cloud API key (key-id:key-secret): '
    read -rs CLICKHOUSE_CLOUD_KEY
    printf '\n'
    export CLICKHOUSE_CLOUD_KEY
  fi
  printf 'Save credentials for future deploys? [Y/n]: '
  read -r SAVE_CREDS
  SAVE_CREDS="${SAVE_CREDS:-Y}"
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

_poll_materialize_idx() {
  local t0 elapsed total left done_parts pct eta row is_done failed
  t0=$(date +%s)
  total=0
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_search_fulltext%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for mutation to register (%ds)...     ' $(( _w * 5 ))
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
      [[ -n "$failed" ]] && { printf '\r  ERROR: mutation failed on part: %s\n' "$failed"; return 1; }
      printf '\r  done — index fully materialized.                              \n'
      return 0
    fi
    [[ $total -eq 0 && "${left:-0}" -gt 0 ]] && total=$left
    elapsed=$(( $(date +%s) - t0 ))
    pct=0; eta='?'
    if [[ $total -gt 0 && -n "$left" ]]; then
      done_parts=$(( total - left ))
      pct=$(( done_parts * 100 / total ))
      if [[ $done_parts -gt 0 && $elapsed -gt 0 ]]; then
        local rate=$(( done_parts / elapsed ))
        [[ $rate -gt 0 ]] && eta="$(( left / rate ))s"
      fi
    fi
    printf '\r  parts remaining: %s / %s (%d%%)  elapsed: %ds  ETA: %s     ' \
      "${left:-?}" "${total:-?}" "$pct" "$elapsed" "$eta"
    sleep 10
  done
}

_poll_count() {
  local table=$1 target=$2 pid=$3
  local t0 elapsed cur pct eta
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    cur=$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM ${table}" 2>/dev/null || echo 0)
    elapsed=$(( $(date +%s) - t0 ))
    pct=0; eta='?'
    [[ ${cur:-0} -gt 0 && $target -gt 0 ]] && pct=$(( cur * 100 / target ))
    if [[ ${cur:-0} -gt 0 && $elapsed -gt 0 ]]; then
      local rate=$(( cur / elapsed ))
      local remaining=$(( target - cur ))
      [[ $rate -gt 0 ]] && eta="$(( remaining / rate ))s"
    fi
    printf '\r  %s: %s / %s (%s%%)  ETA: %s     ' \
      "$table" "${cur:-0}" "$target" "$pct" "$eta"
  done
  printf '\n'
}

_poll_seed() {
  local target=$1 pid=$2
  local t0 elapsed raw
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    raw=$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
      --data-binary "
SELECT 'regions',count() FROM regions
UNION ALL SELECT 'categories',count() FROM categories
UNION ALL SELECT 'products',count() FROM products
UNION ALL SELECT 'customers',count() FROM customers
UNION ALL SELECT 'orders',count() FROM orders
UNION ALL SELECT 'order_items',count() FROM order_items
UNION ALL SELECT 'order_category_facts',count() FROM order_category_facts
" 2>/dev/null || echo "")
    elapsed=$(( $(date +%s) - t0 ))
    printf '%s' "$(awk -F'\t' -v target="$target" -v elapsed="$elapsed" '
      BEGIN {
        n = split("regions categories products customers orders order_items order_category_facts", tbls)
        xp["regions"]=50; xp["categories"]=200; xp["products"]=5000; xp["customers"]=200000
        xp["orders"]=target; xp["order_items"]=target; xp["order_category_facts"]=target
      }
      { cnt[$1] = $2+0 }
      END {
        done=0; active=""; ac=0; ae=0
        for (i=1; i<=n; i++) {
          t=tbls[i]; c=cnt[t]+0; e=xp[t]+0
          if (c>=e && e>0) done++
          else if (c>0 && active=="") { active=t; ac=c; ae=e }
        }
        ord=cnt["orders"]+0
        pct = (target>0 && ord>0) ? int(ord*100/target) : 0
        eta = "?"
        if (ord>0 && elapsed>0) { r=ord/elapsed; rem=target-ord; if (r>0) eta=int(rem/r) "s" }
        sm = (active!="" && active!="orders" && active!="order_items" && active!="order_category_facts") \
             ? sprintf("  inserting: %s (%d/%d)", active, ac, ae) : ""
        printf "\r  [%d/7 done, %d remain]%s  |  orders: %d/%d (%d%%)  ETA: %s     ",
          done, 7-done, sm, ord, target, pct, eta
      }
    ' <<< "$raw")"
  done
  printf '\n'
}

USE_CH_API=0

if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
  USE_CH_API=1
  printf 'Using CLICKHOUSE_CLOUD_KEY from environment.\n\n'
elif [[ -n "${CLICKHOUSE_URL:-}" && -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
  USE_CH_API=0
  printf 'Using CLICKHOUSE_URL from environment: %s\n\n' "$CLICKHOUSE_URL"
elif [[ -f "$CREDS_FILE" ]]; then
  source "$CREDS_FILE"
  if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
    USE_CH_API=1
    printf 'Loaded API key from .clickhouse-creds. Use it? [Y/n]: '
  else
    USE_CH_API=0
    printf 'Loaded saved endpoint: %s. Use it? [Y/n]: ' "${CLICKHOUSE_URL:-}"
  fi
  read -r USE_SAVED
  USE_SAVED="${USE_SAVED:-Y}"
  if [[ ! "$USE_SAVED" =~ ^[Yy] ]]; then
    unset CLICKHOUSE_CLOUD_KEY CLICKHOUSE_URL CLICKHOUSE_PASSWORD
    _prompt_creds
  elif [[ "$USE_CH_API" == "0" ]]; then
    printf 'New password? [Enter to keep saved]: '
    read -rs NEW_PASS
    printf '\n'
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
  command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found in PATH.\n' "$dep"; exit 1; }
done

printf '[1/7] Checking AWS credentials...\n'
aws sts get-caller-identity >/dev/null
printf '  OK\n'

printf '[2/7] Resolving ClickHouse Cloud endpoint...\n'

if [[ "$USE_CH_API" == "1" ]]; then
  CH_ORG_ID="${CLICKHOUSE_ORG_ID:-}"
  CH_SERVICE_NAME="${CLICKHOUSE_SERVICE_NAME:-$PROJECT_NAME}"
  CH_REGION="${CLICKHOUSE_CLOUD_REGION:-aws-us-east-1}"
  CH_TIER="${CLICKHOUSE_CLOUD_TIER:-development}"

  _ch_api() {
    local method="$1" path="$2"; shift 2
    curl -fsSL -X "$method" \
      -H "Authorization: Basic $(printf '%s' "$CLICKHOUSE_CLOUD_KEY" | base64)" \
      -H "Content-Type: application/json" \
      "https://api.clickhouse.cloud/v1${path}" "$@"
  }

  [[ -z "$CH_ORG_ID" ]] && CH_ORG_ID="$(_ch_api GET /organizations | python3 -c \
    "import sys,json;orgs=json.load(sys.stdin).get('result',[]); print(orgs[0]['id'] if orgs else '')" 2>/dev/null || true)"
  [[ -z "$CH_ORG_ID" ]] && { printf 'ERROR: could not determine ClickHouse org ID.\n'; exit 1; }

  EXISTING_SERVICE="$(_ch_api GET "/organizations/${CH_ORG_ID}/services" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for s in data.get('result',[]):
    if s.get('name')=='${CH_SERVICE_NAME}':
        print(json.dumps(s)); break
" 2>/dev/null || true)"

  if [[ -z "$EXISTING_SERVICE" ]]; then
    printf '  Creating new ClickHouse Cloud service (%s / %s)...\n' "$CH_TIER" "$CH_REGION"
    CREATED="$(_ch_api POST "/organizations/${CH_ORG_ID}/services" \
      -d "{\"name\":\"${CH_SERVICE_NAME}\",\"provider\":\"aws\",\"region\":\"${CH_REGION}\",\"tier\":\"${CH_TIER}\"}")"
    CH_HOST="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['endpoints'][0]['hostname'])" 2>/dev/null || true)"
    CH_PASS="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['password'])" 2>/dev/null || true)"
  else
    CH_HOST="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);ep=d.get('endpoints',[]); print(ep[0]['hostname'] if ep else '')" 2>/dev/null || true)"
    CH_SERVICE_ID="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null || true)"
    CH_STATE="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('state',''))" 2>/dev/null || true)"
    CH_PASS="${CLICKHOUSE_PASSWORD:-}"
    if [[ "$CH_STATE" == "idle" || "$CH_STATE" == "stopped" ]]; then
      printf '  Resuming paused service %s...\n' "$CH_SERVICE_ID"
      _ch_api PATCH "/organizations/${CH_ORG_ID}/services/${CH_SERVICE_ID}/state" -d '{"command":"start"}' >/dev/null
    else
      printf '  Service state: %s\n' "$CH_STATE"
    fi
  fi

  [[ -z "$CH_HOST" ]] && { printf 'ERROR: could not determine ClickHouse host.\n'; exit 1; }
  [[ -z "$CH_PASS" ]] && { printf 'ERROR: CLICKHOUSE_PASSWORD required for existing service.\n'; exit 1; }
  CLICKHOUSE_URL="https://${CH_HOST}:8443"
else
  CH_PASS="${CLICKHOUSE_PASSWORD}"
fi

printf '  ClickHouse endpoint: %s\n' "$CLICKHOUSE_URL"
export TF_VAR_clickhouse_url="${CLICKHOUSE_URL}"
export TF_VAR_clickhouse_password="${CH_PASS}"

printf '[3/7] Provisioning ECR + CodeBuild (terraform apply)...\n'
cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null

ECR_IMAGE_EXISTS="$(aws ecr describe-images \
  --repository-name "ch-dash-app" \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)"

if [[ -z "$ECR_IMAGE_EXISTS" || "$ECR_IMAGE_EXISTS" == "None" ]]; then
  printf '  First deploy — provisioning ECR + CodeBuild only (App Runner needs image first).\n'
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

printf '[4/7] Building Docker image via CodeBuild...\n'
TMPZIP="/tmp/${PROJECT_NAME}-source.zip"
cd "$ROOT_DIR"
zip -qr "$TMPZIP" . \
  --exclude ".git/*" \
  --exclude "node_modules/*" \
  --exclude ".next/*" \
  --exclude "infra/.terraform/*" \
  --exclude "infra/terraform.tfstate*" \
  --exclude ".env*" \
  --exclude ".clickhouse-creds"
aws s3 cp "$TMPZIP" "s3://${SRC_BUCKET}/source.zip" --quiet
rm -f "$TMPZIP"

BUILD_ID="$(aws codebuild start-build --project-name "$CB_PROJECT" --query 'build.id' --output text)"
printf '  Build %s started...\n' "$BUILD_ID"

while true; do
  STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)"
  if [[ "$STATUS" == "SUCCEEDED" ]]; then printf '  Build succeeded.\n'; break; fi
  if [[ "$STATUS" == "FAILED" || "$STATUS" == "FAULT" || "$STATUS" == "STOPPED" || "$STATUS" == "TIMED_OUT" ]]; then
    printf 'ERROR: CodeBuild failed (%s). Logs:\n' "$STATUS"
    aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].logs.deepLink' --output text
    exit 1
  fi
  printf '  Status: %s — waiting...\n' "$STATUS"
  sleep 20
done

printf '[5/7] Running schema migrations...\n'
cd "$ROOT_DIR"
export CLICKHOUSE_URL CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}" CLICKHOUSE_PASSWORD="$CH_PASS"

_SORT_KEY="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT sorting_key FROM system.tables WHERE name='orders' AND database='default'" \
  2>/dev/null || echo '')"
if echo "$_SORT_KEY" | grep -q 'toDate'; then
  printf '  Legacy ORDER BY detected — dropping orders table for migration...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary 'DROP TABLE IF EXISTS orders' >/dev/null 2>&1 || true
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary 'DROP TABLE IF EXISTS order_category_facts' >/dev/null 2>&1 || true
fi

npx tsx -e "
  import { runMigrations } from './lib/schema.ts';
  runMigrations().then(() => { console.log('Migrations done'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null || node -e "
  const { runMigrations } = require('./lib/schema.js');
  runMigrations().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
"

printf '[6/7] Seeding and indexing...\n'

_AWS_KEY="$(aws configure get aws_access_key_id 2>/dev/null || echo "${AWS_ACCESS_KEY_ID:-}")"
_AWS_SECRET="$(aws configure get aws_secret_access_key 2>/dev/null || echo "${AWS_SECRET_ACCESS_KEY:-}")"
_CH_DUMP_BUCKET="bikram-nextjs-subsecond-fetch-with-websockets"
_CH_DUMP_S3_KEY="clickhouse-dash/orders.parquet"
_CH_DUMP_S3_PREFIX="https://s3.us-east-1.amazonaws.com/${_CH_DUMP_BUCKET}/clickhouse-dash"

printf '  Checking S3 Parquet dump...\n'
if aws s3 ls "s3://${_CH_DUMP_BUCKET}/${_CH_DUMP_S3_KEY}" >/dev/null 2>&1; then
  printf '  Dump exists — skipping bake.\n'
else
  printf '  No dump found — baking 50M rows to S3...\n'
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
  AWS_ACCESS_KEY_ID="$_AWS_KEY" AWS_SECRET_ACCESS_KEY="$_AWS_SECRET" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh" &
  _BAKE_PID=$!
  _poll_seed 50000000 "$_BAKE_PID"
  wait "$_BAKE_PID"
fi

printf '  Checking demo data...\n'
_SEED_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary 'SELECT count() FROM orders' 2>/dev/null || echo 0)"
if [[ "${_SEED_COUNT:-0}" -gt 0 ]]; then
  printf '  orders: %s rows — skipping seed.\n' "$_SEED_COUNT"
else
  printf '  orders table empty — restoring from S3 dump...\n'
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
  CH_DUMP_S3_PREFIX="$_CH_DUMP_S3_PREFIX" \
  AWS_ACCESS_KEY_ID="$_AWS_KEY" AWS_SECRET_ACCESS_KEY="$_AWS_SECRET" \
    bash "$ROOT_DIR/scripts/seed.sh" &
  _SEED_PID=$!
  _poll_seed 50000000 "$_SEED_PID"
  wait "$_SEED_PID"
fi

printf '  Checking name dictionary...\n'
_NAME_UNIQ="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary "SELECT uniqExact(customerFirstName) FROM orders" 2>/dev/null || echo 0)"
if [[ "${_NAME_UNIQ:-0}" -lt 50 ]]; then
  printf '  Only %s distinct first names — reseeding...\n' "$_NAME_UNIQ"
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
  SEED_FORCE=1 CH_DUMP_S3_PREFIX='' \
    bash "$ROOT_DIR/scripts/seed.sh" &
  _SEED_PID=$!
  _poll_seed 50000000 "$_SEED_PID"
  wait "$_SEED_PID"
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
  AWS_ACCESS_KEY_ID="$_AWS_KEY" AWS_SECRET_ACCESS_KEY="$_AWS_SECRET" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh"
fi

printf '  Checking searchText format...\n'
_SEARCH_FIX="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT if(positionCaseInsensitive(searchText, '@') > 0, 1, 0) FROM orders LIMIT 1" \
  2>/dev/null || echo 0)"
if [[ "${_SEARCH_FIX:-0}" -eq 1 ]]; then
  printf '  Legacy email format — submitting searchText UPDATE...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders UPDATE searchText = concat(customerFirstName, ' ', customerLastName, ' ', toString(orderId), if(coalesce(notes, '') = '', '', concat(' ', coalesce(notes, ''))), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE positionCaseInsensitive(searchText, '@') > 0" \
    2>/dev/null || true
fi

printf '  Checking search index...\n'
_IDX_CHECK="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT countIf(has(skip_indices, 'idx_search_fulltext')), count() FROM system.parts WHERE table='orders' AND active=1" \
  2>/dev/null || echo '0	1')"
_IDX_PARTS="$(printf '%s' "${_IDX_CHECK}" | cut -f1)"
_TOT_PARTS="$(printf '%s' "${_IDX_CHECK}" | cut -f2)"
if [[ "${_TOT_PARTS:-0}" -gt 0 && "${_IDX_PARTS:-0}" -ne "${_TOT_PARTS}" ]]; then
  printf '  %s / %s parts indexed — submitting MATERIALIZE INDEX...\n' "${_IDX_PARTS:-0}" "${_TOT_PARTS:-?}"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders MATERIALIZE INDEX idx_search_fulltext" 2>/dev/null || true
  _poll_materialize_idx
fi

printf '  Checking order_category_facts...\n'
_FACTS_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary 'SELECT count() FROM order_category_facts' 2>/dev/null || echo 0)"
if [[ "${_FACTS_COUNT:-0}" -eq 0 ]]; then
  printf '  order_category_facts empty — backfilling...\n'
  curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "
INSERT INTO order_category_facts
  (orderId, date, placedAt, customerId, regionId, regionCode,
   status, orderTotal, categoryId, categoryName, totalItems, totalRevenue)
SELECT o.orderId, toDate(o.placedAt), o.placedAt, o.customerId, o.regionId, o.regionCode,
  o.status, o.total, i.categoryId, i.categoryName, i.quantity,
  toDecimal64(toFloat64(i.quantity) * toFloat64(i.unitPrice), 2)
FROM orders AS o
INNER JOIN order_items AS i ON i.orderId = o.orderId
" &
  _FACTS_PID=$!
  _poll_count order_category_facts 50000000 "$_FACTS_PID"
  wait "$_FACTS_PID"
fi

printf '[7/7] Completing infrastructure and deploying to App Runner...\n'
cd "$INFRA_DIR"
terraform apply -auto-approve -input=false

APP_RUNNER_ARN="$(terraform output -raw apprunner_service_arn)"
CDN_URL="$(terraform output -raw cdn_url)"

if [[ "$FIRST_DEPLOY" == "0" ]]; then
  aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
fi

while true; do
  SVC_STATUS="$(aws apprunner describe-service \
    --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.Status' --output text)"
  if [[ "$SVC_STATUS" == "RUNNING" ]]; then printf '  App Runner running.\n'; break; fi
  if [[ "$SVC_STATUS" == "CREATE_FAILED" || "$SVC_STATUS" == "UPDATE_FAILED" ]]; then
    printf 'ERROR: App Runner service failed (%s).\n' "$SVC_STATUS"; exit 1
  fi
  printf '  Status: %s — waiting...\n' "$SVC_STATUS"
  sleep 20
done

printf '\n  Dashboard: %s\n' "$CDN_URL"
printf '  Tear down: %s/scripts/infra-down.sh\n\n' "$ROOT_DIR"

if [[ -f "$ROOT_DIR/README.md" ]]; then
  python3 - "$CDN_URL" "$ROOT_DIR/README.md" <<'PYEOF'
import re, sys
url, path = sys.argv[1], sys.argv[2]
content = open(path).read()
content = re.sub(r'(\| \*\*Dashboard\*\* \| )(https?://\S+)( \|)', r'\g<1>' + url + r'\g<3>', content)
content = re.sub(r'(\| \*\*API Explorer\*\* \| )(https?://\S+)( \|)', r'\g<1>' + url + '/api-explorer' + r'\g<3>', content)
open(path, 'w').write(content)
PYEOF
  git -C "$ROOT_DIR" add README.md
  if ! git -C "$ROOT_DIR" diff --cached --quiet; then
    git -C "$ROOT_DIR" commit -m "deploy: update live URL → ${CDN_URL}"
    git -C "$ROOT_DIR" push origin HEAD:main
  fi
fi

PORTFOLIO_SCRIPT="$ROOT_DIR/../../portfolio/scripts/set-live-url.sh"
if [[ -x "$PORTFOLIO_SCRIPT" ]]; then
  bash "$PORTFOLIO_SCRIPT" clickhouse "$CDN_URL"
fi
