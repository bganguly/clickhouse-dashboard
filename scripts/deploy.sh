#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
DATA_DIR="$ROOT_DIR/scripts/data"
PROJECT_NAME="$(basename "$ROOT_DIR")"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/opt/local/bin:$PATH"

_DIAG_LOGS=""
_REUSE_CREDS=""

# Globals set during preflight
_PREFLIGHT_ARN=""; _PREFLIGHT_CDN=""; _PREFLIGHT_CF=""
_DEFAULT_CHOICE=2; _OPTION3_LABEL=""
_CH_PREWARMED=0; _CH_PREFLIGHT_URL=""; _CH_PREFLIGHT_PASS=""
_EC2_PREFLIGHT_IP=""; _EC2_PREFLIGHT_PASS=""; _EC2_PREFLIGHT_STATUS=""
_EC2_PREFLIGHT_INSTANCE_ID=""; _EC2_PREFLIGHT_SG_ID=""; _OPTION4_LABEL=""

# Globals set during cloud deploy
CREDS_FILE="$ROOT_DIR/.clickhouse-creds"
USE_CH_API=0
_GH_REPO=""; _GH_RUN_ST=""
FIRST_DEPLOY=0; _DEPLOY_TAG=""
APP_RUNNER_ARN=""; CDN_URL=""; CF_DIST_ID=""
_OCF_REBUILT=0; _ITEMS_MIGRATION_PENDING=0
_ECR_REPO="ch-dash-app"; _IS_EC2_STACK=0

# ── Utility ───────────────────────────────────────────────────────────────────

_ecr_image_exists() {
  aws ecr describe-images --repository-name "$_ECR_REPO" --image-ids "imageTag=$1" \
    >/dev/null 2>&1
}

_ensure_diag_build_arg() {
  if ! _ecr_image_exists "latest"; then return 0; fi
  local _WANT_TAG _LATEST_DIGEST _WANT_DIGEST
  _WANT_TAG="diag-$([[ -n "$_DIAG_LOGS" ]] && echo "1" || echo "0")"
  _LATEST_DIGEST="$(aws ecr describe-images --repository-name "$_ECR_REPO" \
    --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || echo 'none')"
  _WANT_DIGEST="$(aws ecr describe-images --repository-name "$_ECR_REPO" \
    --image-ids "imageTag=${_WANT_TAG}" --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || echo 'missing')"
  if [[ "$_LATEST_DIGEST" != "$_WANT_DIGEST" || "$_WANT_DIGEST" == "missing" ]]; then
    printf '  [build-arg mismatch] NEXT_PUBLIC_DIAG_LOGS baked into current image does not match requested value\n'
    if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" ]]; then
      printf '%s' "${_DIAG_LOGS}" | gh secret set NEXT_PUBLIC_DIAG_LOGS --repo "$_GH_REPO"
      printf '  Synced NEXT_PUBLIC_DIAG_LOGS secret → pushing rebuild commit...\n'
    else
      printf '  (gh CLI not available — ensure NEXT_PUBLIC_DIAG_LOGS secret is set in GitHub Actions)\n'
      printf '  Pushing rebuild commit...\n'
    fi
    git -C "$ROOT_DIR" commit --allow-empty -m "chore: rebuild for NEXT_PUBLIC_DIAG_LOGS=${_DIAG_LOGS}"
    git -C "$ROOT_DIR" push origin HEAD:main
    return 1
  fi
  printf '  NEXT_PUBLIC_DIAG_LOGS build-arg matches current image — no rebuild needed.\n'
  return 0
}

_ch_cloud_start() {
  local _KEY _HOSTNAME _ORG _SVC _RESP
  _KEY="$(grep '^CLICKHOUSE_CLOUD_KEY=' "$ROOT_DIR/.clickhouse-creds" 2>/dev/null | cut -d= -f2-)"
  [[ -z "$_KEY" ]] && return 0
  _HOSTNAME="$(printf '%s' "${_CH_PREFLIGHT_URL:-}" | sed 's|https://||; s|:.*||')"
  [[ -z "$_HOSTNAME" ]] && return 0
  printf '  Calling ClickHouse Cloud API to start service...\n'
  _ORG="$(curl -fsSL -X GET \
    -H "Authorization: Basic $(printf '%s' "$_KEY" | base64)" \
    "https://api.clickhouse.cloud/v1/organizations" 2>/dev/null \
    | python3 -c "import sys,json;r=json.load(sys.stdin).get('result',[]); print(r[0]['id'] if r else '')" 2>/dev/null || echo '')"
  if [[ -z "$_ORG" ]]; then
    printf '  Could not resolve org ID — skipping API start.\n'; return 0
  fi
  _SVC="$(curl -fsSL -X GET \
    -H "Authorization: Basic $(printf '%s' "$_KEY" | base64)" \
    "https://api.clickhouse.cloud/v1/organizations/${_ORG}/services" 2>/dev/null \
    | python3 -c "
import sys, json
for s in json.load(sys.stdin).get('result', []):
    for ep in s.get('endpoints', []):
        if '${_HOSTNAME}' in ep.get('hostname', ''):
            print(s['id']); break
" 2>/dev/null || echo '')"
  if [[ -z "$_SVC" ]]; then
    printf '  Could not find service for %s — skipping API start.\n' "$_HOSTNAME"; return 0
  fi
  _RESP="$(curl -sS -X PATCH \
    -H "Authorization: Basic $(printf '%s' "$_KEY" | base64)" \
    -H "Content-Type: application/json" \
    "https://api.clickhouse.cloud/v1/organizations/${_ORG}/services/${_SVC}/state" \
    -d '{"command":"start"}' 2>&1 || true)"
  [[ -n "$_RESP" ]] && printf '  API: %s\n' "$_RESP"
}

_ch_wait_ready() {
  local label="${1}" url="${2}" pass="${3}" timeout_sec="${4:-180}" on_timeout="${5:-abort}"
  local deadline=$(( $(date +%s) + timeout_sec )) remaining ping attempt=0
  printf '%s Waiting for ClickHouse to be reachable...\n' "$label"
  while true; do
    ping="$(curl -sf --max-time 8 -u "default:${pass}" \
      "${url}/?default_format=TabSeparated&max_execution_time=5" \
      --data-binary "SELECT 1" 2>/dev/null || echo '')"
    if [[ "$ping" == "1" ]]; then printf '  ClickHouse ready.\n'; return 0; fi
    remaining=$(( deadline - $(date +%s) ))
    if (( remaining <= 0 )); then
      if [[ "$on_timeout" == "skip" ]]; then
        printf '  ClickHouse not reachable after %ds — skipping DB checks.\n' "$timeout_sec"; exit 0
      else
        printf '\nERROR: ClickHouse not reachable after %ds — aborting deploy.\n' "$timeout_sec"; exit 1
      fi
    fi
    attempt=$(( attempt + 1 ))
    printf '\r  not ready (%ds remaining)...' "$remaining"
    sleep 10
  done
}

_sql_array() {
  awk "BEGIN{ORS=\"\"} NR>1{print \",\"} {gsub(/'/, \"''\"); print \"'\" \$0 \"'\"}" "$1"
}

# ── Poll functions ────────────────────────────────────────────────────────────

_poll_mutation() {
  local label="$1" table="$2" like_clause="$3" done_msg="$4"
  local t0 elapsed row is_done left failed total=0
  t0=$(date +%s)
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='${table}' AND command LIKE '${like_clause}' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for %s mutation to register (%ds)...' "$label" $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do, latest_failed_part FROM system.mutations WHERE table='${table}' AND command LIKE '${like_clause}' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    failed="$(printf '%s' "$row" | cut -f3)"
    if [[ "$is_done" == "1" ]]; then
      [[ -n "$failed" ]] && { printf '\n  ERROR: %s mutation failed on part: %s\n' "$label" "$failed"; return 1; }
      printf '\r  done — %s\n' "$done_msg"; return 0
    fi
    [[ $total -eq 0 && "${left:-0}" -gt 0 ]] && total=$left
    elapsed=$(( $(date +%s) - t0 ))
    if (( elapsed > 1200 )); then
      printf '\n  timed out after 20 min — mutation did not appear in system.mutations (may have completed instantly).\n'; return 0
    fi
    if [[ "${total:-0}" -gt 0 ]]; then
      printf '\r  parts remaining: %s / %s  elapsed: %ds' "${left:-?}" "$total" "$elapsed"
    else
      printf '\r  parts remaining: %s  elapsed: %ds' "${left:-?}" "$elapsed"
    fi
    sleep 10
  done
}

_poll_update_mutation()      { _poll_mutation "UPDATE searchText" "orders" "%UPDATE searchText%" "searchText backfill complete."; }
_poll_materialize_idx()      { _poll_mutation "MATERIALIZE INDEX idx_search_fulltext" "orders" "%MATERIALIZE INDEX%idx_search_fulltext%" "index fully materialized."; }
_poll_ocf_mutation()         { _poll_mutation "OCF UPDATE searchText" "order_category_facts" "%UPDATE searchText%" "order_category_facts.searchText backfill complete."; }
_poll_notes_ngram_idx()      { _poll_mutation "idx_notes_ngram" "orders" "%MATERIALIZE INDEX%idx_notes_ngram%" "idx_notes_ngram materialized."; }
_poll_ocf_idx()              { _poll_mutation "idx_ocf_search" "order_category_facts" "%MATERIALIZE INDEX%idx_ocf_search%" "idx_ocf_search materialized."; }

# ── Preflight ─────────────────────────────────────────────────────────────────

_run_preflight() {
  printf '[preflight] Checking AWS credentials... '
  if ! command -v aws >/dev/null 2>&1 || ! aws sts get-caller-identity >/dev/null 2>&1; then
    printf 'failed\n'
    _ch_preflight_check
    return
  fi
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
    local _TMP_ARN
    _TMP_ARN="$(aws apprunner list-services \
      --query "ServiceSummaryList[?ServiceName=='ch-dash-app'].ServiceArn | [0]" \
      --output text 2>/dev/null || true)"
    if [[ "$_TMP_ARN" != "None" && -n "$_TMP_ARN" ]]; then
      _PREFLIGHT_ARN="$_TMP_ARN"; printf 'found\n'
    else
      printf 'not found\n'
    fi
  fi

  if [[ -n "$_PREFLIGHT_ARN" ]]; then
    _preflight_check_gh_run
  fi

  _ch_preflight_check
  _ec2_preflight_check
}

_preflight_check_gh_run() {
  local _LOCAL_SHA _LOCAL_MSG _LOCAL_AGO _GH_RUN_JSON _GH_RUN_ID _GH_RUN_SHA _GH_RUN_TITLE
  _LOCAL_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
  _LOCAL_MSG="$(git -C "$ROOT_DIR" log -1 --format='%s' 2>/dev/null || echo '')"
  _LOCAL_AGO="$(git -C "$ROOT_DIR" log -1 --format='%ar' 2>/dev/null || echo '')"
  printf '[preflight] HEAD commit : %s — "%s" (%s)\n' "${_LOCAL_SHA:-unknown}" "$_LOCAL_MSG" "$_LOCAL_AGO"

  if ! command -v gh >/dev/null 2>&1; then return; fi

  _GH_RUN_JSON="$(gh run list --limit 1 \
    --json databaseId,status,conclusion,headSha,displayTitle 2>/dev/null || echo '')"
  local _GH_RUN_ID _GH_RUN_TITLE
  _GH_RUN_ID="$(printf '%s' "$_GH_RUN_JSON" | python3 -c \
    "import sys,json; r=json.load(sys.stdin); print(r[0]['databaseId'] if r else '')" 2>/dev/null || echo '')"
  _GH_RUN_ST="$(printf '%s' "$_GH_RUN_JSON" | python3 -c \
    "import sys,json; r=json.load(sys.stdin); o=r[0] if r else {}; co=o.get('conclusion') or ''; st=o.get('status',''); print(st+'/'+co if co else st)" 2>/dev/null || echo '')"
  _GH_RUN_SHA="$(printf '%s' "$_GH_RUN_JSON" | python3 -c \
    "import sys,json; r=json.load(sys.stdin); print(r[0]['headSha'][:7] if r else '')" 2>/dev/null || echo '')"
  _GH_RUN_TITLE="$(printf '%s' "$_GH_RUN_JSON" | python3 -c \
    "import sys,json; r=json.load(sys.stdin); print(r[0]['displayTitle'] if r else '')" 2>/dev/null || echo '')"
  printf '[preflight] GH Actions  : %s · %s · %s\n' "$_GH_RUN_ST" "$_GH_RUN_SHA" "$_GH_RUN_TITLE"

  if [[ "$_GH_RUN_ST" == "in_progress" || "$_GH_RUN_ST" == "queued" || "$_GH_RUN_ST" == "waiting" ]] \
      && [[ -n "$_GH_RUN_ID" ]]; then
    _preflight_wait_gh_run "$_GH_RUN_ID"
  fi

  local _LOCAL_SHA2
  _LOCAL_SHA2="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
  _LOCAL_AGO="$(git -C "$ROOT_DIR" log -1 --format='%ar' 2>/dev/null || echo '')"
  printf '[preflight] Checking ECR for current commit (%s)... ' "${_LOCAL_SHA2:-unknown}"
  if [[ -n "$_LOCAL_SHA2" ]] && _ecr_image_exists "$_LOCAL_SHA2"; then
    printf 'built\n'
    _OPTION3_LABEL="Quick  — redeploy ECR:latest direct to App Runner · HEAD=${_LOCAL_SHA2} (${_LOCAL_AGO}) · skips Terraform/DB/migration checks"
    [[ "$_GH_RUN_ST" == "completed/success" ]] && _DEFAULT_CHOICE=3 || true
  else
    printf 'not built yet\n'
    _OPTION3_LABEL="Quick  — UNAVAILABLE · HEAD=${_LOCAL_SHA2:-unknown} (${_LOCAL_AGO:-unknown age}) not yet in ECR — wait for GH Actions build to complete"
  fi
}

_preflight_wait_gh_run() {
  local run_id="$1" _gh_t0 _gh_view _gh_cur_st _gh_conclusion _step_build _step_migration
  printf '[preflight] Waiting for GH Actions to finish (polls every 20s)...\n'
  _gh_t0=$(date +%s)
  while true; do
    sleep 20
    _gh_view="$(gh run view "$run_id" --json status,conclusion,jobs 2>/dev/null || echo '')"
    _gh_cur_st="$(printf '%s' "$_gh_view" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo '')"
    printf '\r  %s (%ds)...' "${_gh_cur_st:-waiting}" $(( $(date +%s) - _gh_t0 ))
    if [[ "$_gh_cur_st" != "in_progress" && "$_gh_cur_st" != "queued" && "$_gh_cur_st" != "waiting" ]]; then
      printf '\n'; break
    fi
  done
  _gh_conclusion="$(printf '%s' "$_gh_view" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('conclusion') or '')" 2>/dev/null || echo '')"
  _step_build="$(printf '%s' "$_gh_view" | python3 -c "
import sys, json
for step in json.load(sys.stdin).get('jobs',[{}])[0].get('steps',[]):
    if 'push' in step.get('name','').lower() or 'build' in step.get('name','').lower():
        print(step.get('conclusion','unknown')); break
else: print('unknown')
" 2>/dev/null || echo 'unknown')"
  _step_migration="$(printf '%s' "$_gh_view" | python3 -c "
import sys, json
for step in json.load(sys.stdin).get('jobs',[{}])[0].get('steps',[]):
    if 'migration' in step.get('name','').lower():
        print(step.get('conclusion','unknown')); break
else: print('unknown')
" 2>/dev/null || echo 'unknown')"
  printf '  build/push : %s\n' "$_step_build"
  printf '  migration  : %s\n' "$_step_migration"
  if [[ "$_step_migration" != "success" ]]; then
    printf '\nERROR: ClickHouse migration step %s — aborting.\n' "$_step_migration"
    printf '  Check the GH Actions log for details, fix the issue, then re-run deploy.sh.\n'
    exit 1
  fi
  _GH_RUN_ST="completed/${_gh_conclusion}"
}

_ch_preflight_check() {
  _CH_PREFLIGHT_URL="$(grep '^CLICKHOUSE_URL=' "$ROOT_DIR/.clickhouse-creds" 2>/dev/null | cut -d= -f2-)"
  _CH_PREFLIGHT_PASS="$(grep '^CLICKHOUSE_PASSWORD=' "$ROOT_DIR/.clickhouse-creds" 2>/dev/null | cut -d= -f2-)"
  [[ -z "$_CH_PREFLIGHT_URL" || -z "$_CH_PREFLIGHT_PASS" ]] && return 0

  printf '[preflight] Checking ClickHouse reachability... '
  local _ping
  _ping="$(curl -sf --max-time 8 -u "default:${_CH_PREFLIGHT_PASS}" \
    "${_CH_PREFLIGHT_URL}/?default_format=TabSeparated&max_execution_time=5" \
    --data-binary "SELECT 1" 2>/dev/null || echo '')"
  if [[ "$_ping" == "1" ]]; then
    printf 'reachable\n'; _CH_PREWARMED=1
  else
    printf 'paused — attempting to start\n'
    _ch_cloud_start
    curl -sf --max-time 60 -u "default:${_CH_PREFLIGHT_PASS}" \
      "${_CH_PREFLIGHT_URL}/?default_format=TabSeparated&max_execution_time=5" \
      --data-binary "SELECT 1" >/dev/null 2>&1 &
  fi
}

_ec2_preflight_check() {
  [[ ! -f "$ROOT_DIR/.ec2-creds" ]] && return 0
  local _ip _pass
  _ip="$(grep '^EC2_PUBLIC_IP=' "$ROOT_DIR/.ec2-creds" 2>/dev/null | cut -d= -f2-)"
  _pass="$(grep '^EC2_PASS=' "$ROOT_DIR/.ec2-creds" 2>/dev/null | cut -d= -f2-)"
  [[ -z "$_ip" || -z "$_pass" ]] && return 0

  _EC2_PREFLIGHT_IP="$_ip"
  _EC2_PREFLIGHT_PASS="$_pass"
  _EC2_PREFLIGHT_INSTANCE_ID="$(grep '^EC2_INSTANCE_ID=' "$ROOT_DIR/.ec2-creds" 2>/dev/null | cut -d= -f2-)"
  _EC2_PREFLIGHT_SG_ID="$(grep '^EC2_SG_ID=' "$ROOT_DIR/.ec2-creds" 2>/dev/null | cut -d= -f2-)"

  printf '[preflight] Checking EC2 ClickHouse (%s)... ' "$_ip"
  local _ping
  _ping="$(curl -sf --max-time 8 -u "default:${_pass}" \
    "http://${_ip}:8123/?default_format=TabSeparated&max_execution_time=5" \
    --data-binary "SELECT 1" 2>/dev/null || echo '')"
  if [[ "$_ping" == "1" ]]; then
    printf 'reachable\n'
    _EC2_PREFLIGHT_STATUS="reachable"
    _OPTION4_LABEL="EC2    — existing EC2 ClickHouse at ${_ip} · reachable · redeploy app only"
  else
    printf 'NOT reachable\n'
    _EC2_PREFLIGHT_STATUS="unreachable"
    _OPTION4_LABEL="EC2    — existing EC2 ClickHouse at ${_ip} · NOT reachable · choose: re-provision or manual entry"
  fi
}

# ── Option 1: local dev ───────────────────────────────────────────────────────

_deploy_local() {
  cd "$ROOT_DIR"
  if [[ -f ".env.local" ]]; then
    grep -v '^NEXT_PUBLIC_DIAG_LOGS=' .env.local > .env.local.tmp && mv .env.local.tmp .env.local
  fi
  [[ -n "$_DIAG_LOGS" ]] && printf 'NEXT_PUBLIC_DIAG_LOGS=%s\n' "$_DIAG_LOGS" >> .env.local
  npm install --prefer-offline || npm install
  exec npm run dev
}

# ── Option 3: quick redeploy ──────────────────────────────────────────────────

_deploy_quick() {
  printf '\n[quick] Checking AWS credentials...\n'
  aws sts get-caller-identity >/dev/null
  printf '  OK\n'

  APP_RUNNER_ARN="$_PREFLIGHT_ARN"
  CDN_URL="$_PREFLIGHT_CDN"
  CF_DIST_ID="${_PREFLIGHT_CF:-}"

  if [[ -z "$APP_RUNNER_ARN" ]]; then
    printf '[quick] Terraform state empty — querying App Runner...\n'
    local _TMP
    _TMP="$(aws apprunner list-services \
      --query "ServiceSummaryList[?ServiceName=='ch-dash-app'].ServiceArn | [0]" \
      --output text 2>/dev/null || true)"
    [[ "$_TMP" != "None" && -n "$_TMP" ]] && APP_RUNNER_ARN="$_TMP"
  fi
  [[ -z "$APP_RUNNER_ARN" ]] && { printf 'ERROR: no App Runner ARN found — run a full deploy (option 2) first.\n'; exit 1; }

  if [[ -z "$CDN_URL" ]]; then
    local _AR_URL
    _AR_URL="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" \
      --query 'Service.ServiceUrl' --output text 2>/dev/null || true)"
    [[ -n "$_AR_URL" ]] && CDN_URL="https://${_AR_URL}"
  fi

  printf '[quick] ARN: %s\n' "$APP_RUNNER_ARN"
  ! _ecr_image_exists "latest" && { printf 'ERROR: no latest image in ECR — push to GitHub and wait for Actions build first.\n'; exit 1; }

  printf '[quick] Checking NEXT_PUBLIC_DIAG_LOGS build-arg...\n'
  if ! _ensure_diag_build_arg; then
    _quick_wait_ecr_image "$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  fi

  local _HEAD_SHA
  _HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  ! _ecr_image_exists "$_HEAD_SHA" && _quick_wait_ecr_image "$_HEAD_SHA"

  _quick_wait_apprunner_idle
  _quick_ch_wait_if_needed

  printf '[quick] Starting App Runner deployment...\n'
  aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
  _quick_wait_apprunner_running
  printf '  Startup instrumentation complete — Redis and ClickHouse connections pre-warmed.\n'

  if [[ -n "${CF_DIST_ID:-}" ]]; then
    printf '[quick] Invalidating CloudFront cache...\n'
    aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" \
      --query 'Invalidation.Id' --output text
  fi

  local _AR_SVC_URL _READY_URL
  _AR_SVC_URL="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.ServiceUrl' --output text 2>/dev/null || true)"
  _READY_URL="${_CH_PREFLIGHT_URL:-${CDN_URL:-}}"
  [[ -z "$_READY_URL" && -n "$_AR_SVC_URL" ]] && _READY_URL="https://${_AR_SVC_URL}"
  [[ -z "$CDN_URL" && -n "$_AR_SVC_URL" ]] && CDN_URL="https://${_AR_SVC_URL}"

  _ch_wait_ready "[quick]" "$_READY_URL" "${_CH_PREFLIGHT_PASS:-}" 180 abort

  _prime_cdn_caches

  printf '\n  Dashboard: %s\n' "${CDN_URL:-}"
  exit 0
}

_quick_wait_ecr_image() {
  local sha="$1"
  printf '[quick] Waiting for ECR image %s (up to 15 min)...\n' "$sha"
  local elapsed=0 manifest
  until _ecr_image_exists "$sha"; do
    if (( elapsed >= 900 )); then
      local repo
      repo="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null \
        | sed 's|.*github\.com[:/]\(.*\)\.git$|\1|; s|.*github\.com[:/]\(.*\)$|\1|')"
      printf '  Timed out. Check Actions: https://github.com/%s/actions\n' "${repo:-}"
      exit 1
    fi
    sleep 30; elapsed=$(( elapsed + 30 ))
    printf '  ...%ds elapsed\n' "$elapsed"
  done
  printf '  Image %s ready — re-tagging as latest.\n' "$sha"
  manifest="$(aws ecr batch-get-image --repository-name "ch-dash-app" \
    --image-ids "imageTag=${sha}" --query 'images[0].imageManifest' --output text 2>/dev/null)"
  aws ecr put-image --repository-name "ch-dash-app" --image-tag latest \
    --image-manifest "$manifest" >/dev/null 2>&1 || true
}

_quick_wait_apprunner_idle() {
  printf '[quick] Checking App Runner state...\n'
  local status
  status="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.Status' --output text)"
  [[ "$status" != "OPERATION_IN_PROGRESS" ]] && { [[ "$status" == "RUNNING" ]] || { printf 'ERROR: App Runner in unexpected state: %s\n' "$status"; exit 1; }; return; }
  printf '  Deployment already in progress — waiting for it to finish before starting ours...\n'
  local t0=$(date +%s)
  while [[ "$status" == "OPERATION_IN_PROGRESS" ]]; do
    sleep 20
    status="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
    printf '\r  %s... (%ds)' "$status" $(( $(date +%s) - t0 ))
  done
  printf '\n'
  [[ "$status" == "RUNNING" ]] || { printf 'ERROR: App Runner in unexpected state: %s\n' "$status"; exit 1; }
}

_quick_wait_apprunner_running() {
  local t0=$(date +%s) status
  while true; do
    status="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
    if [[ "$status" == "RUNNING" ]]; then printf '\r  Running (%ds).  \n' $(( $(date +%s) - t0 )); break; fi
    if [[ "$status" == "UPDATE_FAILED" ]]; then printf '\nERROR: App Runner %s.\n' "$status"; exit 1; fi
    printf '\r  %s... (%ds)' "$status" $(( $(date +%s) - t0 ))
    sleep 20
  done
}

_quick_ch_wait_if_needed() {
  [[ "$_CH_PREWARMED" -eq 1 ]] && return 0
  [[ -z "$_CH_PREFLIGHT_URL" || -z "$_CH_PREFLIGHT_PASS" ]] && return 0
  _ch_wait_ready "[quick]" "$_CH_PREFLIGHT_URL" "$_CH_PREFLIGHT_PASS" 180 abort
  _CH_PREWARMED=1
}

# ── Option 2: cloud deploy ────────────────────────────────────────────────────

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

_load_ch_creds() {
  if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
    USE_CH_API=1
  elif [[ -n "${CLICKHOUSE_URL:-}" && -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
    USE_CH_API=0
  elif [[ -f "$CREDS_FILE" ]]; then
    source "$CREDS_FILE"
    if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
      USE_CH_API=1
      if [[ -z "$_REUSE_CREDS" ]]; then
        printf 'Loaded API key from .clickhouse-creds. Use it? [Y/n]: '
        read -r USE_SAVED; USE_SAVED="${USE_SAVED:-Y}"
      else
        USE_SAVED="Y"; printf 'Loaded API key from .clickhouse-creds (reusing).\n'
      fi
    else
      USE_CH_API=0
      if [[ -z "$_REUSE_CREDS" ]]; then
        printf 'Loaded saved endpoint: %s. Use it? [Y/n]: ' "${CLICKHOUSE_URL:-}"
        read -r USE_SAVED; USE_SAVED="${USE_SAVED:-Y}"
      else
        USE_SAVED="Y"; printf 'Loaded saved endpoint: %s (reusing).\n' "${CLICKHOUSE_URL:-}"
      fi
    fi
    if [[ ! "$USE_SAVED" =~ ^[Yy] ]]; then
      unset CLICKHOUSE_CLOUD_KEY CLICKHOUSE_URL CLICKHOUSE_PASSWORD
      _prompt_creds
    elif [[ "$USE_CH_API" == "0" && -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
      printf 'ClickHouse password: '
      read -rs CLICKHOUSE_PASSWORD; printf '\n'
      export CLICKHOUSE_PASSWORD
      printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
        "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
      chmod 600 "$CREDS_FILE"
    fi
  else
    _prompt_creds
  fi
}

_check_deps() {
  for dep in aws terraform; do
    command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found.\n' "$dep"; exit 1; }
  done
}

_sync_aws_gh_secrets() {
  printf '[1/5] Checking AWS credentials...\n'
  aws sts get-caller-identity >/dev/null
  printf '  OK\n'

  _GH_REPO="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null \
    | sed 's|.*github\.com[:/]\(.*\)\.git$|\1|; s|.*github\.com[:/]\(.*\)$|\1|')"
  if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" ]]; then
    printf '  Syncing AWS credentials to GitHub Actions secrets (%s)...\n' "$_GH_REPO"
    local _AWS_REGION
    _AWS_REGION="$(aws configure get region 2>/dev/null || echo "us-east-1")"
    aws configure get aws_access_key_id     | gh secret set AWS_ACCESS_KEY_ID     --repo "$_GH_REPO"
    aws configure get aws_secret_access_key | gh secret set AWS_SECRET_ACCESS_KEY --repo "$_GH_REPO"
    printf '%s' "$_AWS_REGION"              | gh secret set AWS_REGION            --repo "$_GH_REPO"
  fi
}

_resolve_ch_endpoint() {
  printf '[2/5] Resolving ClickHouse endpoint...\n'
  local CH_PASS_LOCAL
  if [[ "$USE_CH_API" == "1" ]]; then
    local CH_ORG_ID CH_SERVICE_NAME CH_REGION CH_TIER CH_HOST
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

    local EXISTING
    EXISTING="$(_ch_api GET "/organizations/${CH_ORG_ID}/services" | python3 -c "
import sys,json
for s in json.load(sys.stdin).get('result',[]):
    if s.get('name')=='${CH_SERVICE_NAME}': print(json.dumps(s)); break
" 2>/dev/null || true)"

    if [[ -z "$EXISTING" ]]; then
      printf '  Creating new ClickHouse Cloud service...\n'
      local CREATED
      CREATED="$(_ch_api POST "/organizations/${CH_ORG_ID}/services" \
        -d "{\"name\":\"${CH_SERVICE_NAME}\",\"provider\":\"aws\",\"region\":\"${CH_REGION}\",\"tier\":\"${CH_TIER}\"}")"
      CH_HOST="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['endpoints'][0]['hostname'])" 2>/dev/null)"
      CH_PASS_LOCAL="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['password'])" 2>/dev/null)"
    else
      CH_HOST="$(printf '%s' "$EXISTING" | python3 -c "import sys,json;ep=json.load(sys.stdin).get('endpoints',[]); print(ep[0]['hostname'] if ep else '')" 2>/dev/null)"
      local CH_SVC_ID CH_STATE
      CH_SVC_ID="$(printf '%s' "$EXISTING" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)"
      CH_STATE="$(printf '%s' "$EXISTING" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))" 2>/dev/null)"
      CH_PASS_LOCAL="${CLICKHOUSE_PASSWORD:-}"
      if [[ "$CH_STATE" == "idle" || "$CH_STATE" == "stopped" ]]; then
        printf '  Resuming paused service...\n'
        _ch_api PATCH "/organizations/${CH_ORG_ID}/services/${CH_SVC_ID}/state" -d '{"command":"start"}' >/dev/null
      fi
    fi

    [[ -z "$CH_HOST" ]] && { printf 'ERROR: could not determine ClickHouse host.\n'; exit 1; }
    [[ -z "$CH_PASS_LOCAL" ]] && { printf 'ERROR: CLICKHOUSE_PASSWORD required.\n'; exit 1; }
    CLICKHOUSE_URL="https://${CH_HOST}:8443"
  else
    CH_PASS_LOCAL="${CLICKHOUSE_PASSWORD}"
  fi

  CH_PASS="$CH_PASS_LOCAL"
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
}

_load_redis_creds() {
  local REDIS_CREDS_FILE="$ROOT_DIR/.redis-creds"
  if [[ -n "${REDIS_URL:-}" ]]; then
    printf '  Using REDIS_URL from environment.\n'
  elif [[ -f "$REDIS_CREDS_FILE" ]]; then
    REDIS_URL="$(grep '^REDIS_URL=' "$REDIS_CREDS_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-)"
    local _REDIS_DISPLAY
    _REDIS_DISPLAY="$(printf '%s' "${REDIS_URL:-}" | sed 's|:\([^:@]*\)@|:***@|')"
    if [[ -z "$_REUSE_CREDS" ]]; then
      printf '  Loaded Redis URL from .redis-creds: %s. Use it? [Y/n]: ' "$_REDIS_DISPLAY"
      read -r USE_REDIS_SAVED; USE_REDIS_SAVED="${USE_REDIS_SAVED:-Y}"
    else
      USE_REDIS_SAVED="Y"; printf '  Loaded Redis URL from .redis-creds: %s (reusing).\n' "$_REDIS_DISPLAY"
    fi
    [[ ! "$USE_REDIS_SAVED" =~ ^[Yy] ]] && unset REDIS_URL
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
}

_load_typesense_creds() {
  local TS_CREDS_FILE="$ROOT_DIR/.typesense-creds"
  if [[ -n "${TYPESENSE_URL:-}" && -n "${TYPESENSE_API_KEY:-}" ]]; then
    printf '  Using Typesense credentials from environment.\n'
  elif [[ -f "$TS_CREDS_FILE" ]]; then
    source "$TS_CREDS_FILE"
    if [[ -z "$_REUSE_CREDS" ]]; then
      printf '  Loaded Typesense URL from .typesense-creds: %s. Use it? [Y/n]: ' "${TYPESENSE_URL:-}"
      read -r USE_TS_SAVED; USE_TS_SAVED="${USE_TS_SAVED:-Y}"
    else
      USE_TS_SAVED="Y"; printf '  Loaded Typesense URL from .typesense-creds: %s (reusing).\n' "${TYPESENSE_URL:-}"
    fi
    if [[ ! "$USE_TS_SAVED" =~ ^[Yy] ]]; then
      unset TYPESENSE_URL TYPESENSE_API_KEY
    else
      if [[ -z "$_REUSE_CREDS" ]]; then
        printf '  Use saved API key? [Y/n]: '
        read -r USE_TS_KEY; USE_TS_KEY="${USE_TS_KEY:-Y}"
      else
        USE_TS_KEY="Y"
      fi
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
}

_provision_infra() {
  printf '[3/5] Provisioning infrastructure (terraform apply)...\n'
  cd "$INFRA_DIR"
  terraform init -input=false -upgrade >/dev/null
  printf '  Pruning stale state...\n'
  terraform state rm aws_codebuild_project.app           2>/dev/null || true
  terraform state rm aws_iam_role_policy.codebuild       2>/dev/null || true
  terraform state rm aws_iam_role.codebuild              2>/dev/null || true
  terraform state rm aws_s3_bucket.codebuild_src         2>/dev/null || true

  local _STATE_FILE="$INFRA_DIR/terraform.tfstate"
  if [[ -f "$_STATE_FILE" ]]; then
    python3 -c "
import json
with open('$_STATE_FILE') as f: s = json.load(f)
for k in ('codebuild_source_bucket', 'codebuild_project_name'):
    s.get('outputs', {}).pop(k, None)
with open('$_STATE_FILE', 'w') as f: json.dump(s, f, indent=2)
" 2>/dev/null || true
  fi

  local ECR_IMAGE_EXISTS
  ECR_IMAGE_EXISTS="$(aws ecr describe-images \
    --repository-name "$_ECR_REPO" --image-ids imageTag=latest \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)"

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

  printf '[deploy] Verifying NEXT_PUBLIC_DIAG_LOGS build-arg...\n'
  _ensure_diag_build_arg || true
}

_verify_ecr_image() {
  printf '[4/5] Verifying image in ECR...\n'
  local _REMOTE_SHA
  _REMOTE_SHA="$(git -C "$ROOT_DIR" ls-remote origin HEAD 2>/dev/null | cut -c1-7)"
  _DEPLOY_TAG="${_REMOTE_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "latest")}"
  printf '  Checking ECR for image %s...\n' "$_DEPLOY_TAG"

  if ! _ecr_image_exists "$_DEPLOY_TAG"; then
    if _ecr_image_exists "latest"; then
      _verify_ecr_handle_latest_fallback
    elif [[ "$_IS_EC2_STACK" -eq 1 ]]; then
      _ec2_copy_ecr_image
      printf '  Waiting for GH Actions to push %s:latest (up to 15 min)...\n' "$_ECR_REPO"
      local elapsed=0
      until _ecr_image_exists "latest"; do
        if (( elapsed >= 900 )); then
          printf '  Timed out. Check Actions: https://github.com/%s/actions\n' "${_GH_REPO:-bganguly/clickhouse-dashboard}"
          exit 1
        fi
        sleep 15; elapsed=$(( elapsed + 15 ))
        printf '  ...%ds\n' "$elapsed"
      done
      _DEPLOY_TAG=latest
    else
      printf '  No image in ECR yet — waiting for GitHub Actions build (up to 10 min)...\n'
      local elapsed=0
      until _ecr_image_exists "latest"; do
        if (( elapsed >= 600 )); then
          printf '  Timed out. Check Actions: https://github.com/bganguly/clickhouse-dashboard/actions\n'
          exit 1
        fi
        sleep 15; elapsed=$(( elapsed + 15 ))
        printf '  ...%ds\n' "$elapsed"
      done
      _DEPLOY_TAG=latest
    fi
  fi

  printf '  Image %s found in ECR.\n' "$_DEPLOY_TAG"
  local _MANIFEST
  _MANIFEST=$(aws ecr batch-get-image --repository-name "$_ECR_REPO" \
    --image-ids "imageTag=${_DEPLOY_TAG}" --query 'images[0].imageManifest' \
    --output text 2>/dev/null)
  if [[ "$_DEPLOY_TAG" != "latest" ]]; then
    aws ecr put-image --repository-name "$_ECR_REPO" --image-tag latest \
      --image-manifest "$_MANIFEST" >/dev/null 2>&1 \
      && printf '  Re-tagged %s as latest.\n' "$_DEPLOY_TAG" || true
  fi
}

_verify_ecr_handle_latest_fallback() {
  local _GH_BUILD_ACTIVE=0
  if command -v gh >/dev/null 2>&1 && [[ -n "${_GH_REPO:-}" ]]; then
    local _GH_RUN_STATUS
    _GH_RUN_STATUS="$(gh run list --repo "$_GH_REPO" --limit 5 --json headSha,status \
      --jq ".[] | select((.status == \"in_progress\") or (.status == \"queued\")) | select(.headSha | startswith(\"${_DEPLOY_TAG}\")) | .status" \
      2>/dev/null | head -1 || echo '')"
    [[ -n "$_GH_RUN_STATUS" ]] && _GH_BUILD_ACTIVE=1
  fi
  if [[ "$_GH_BUILD_ACTIVE" -eq 1 ]]; then
    printf '  GH Actions is building %s — polling ECR every 30s (up to 15 min)...\n' "$_DEPLOY_TAG"
    local elapsed=0
    until _ecr_image_exists "$_DEPLOY_TAG"; do
      if (( elapsed >= 900 )); then
        printf '  Timed out. Check Actions: https://github.com/%s/actions\n' "$_GH_REPO"
        exit 1
      fi
      sleep 30; elapsed=$(( elapsed + 30 ))
      printf '  ...%ds elapsed\n' "$elapsed"
    done
    printf '  Image %s now in ECR.\n' "$_DEPLOY_TAG"
  else
    printf '  SHA %s not in ECR (code unchanged since last build) — using latest.\n' "$_DEPLOY_TAG"
    _DEPLOY_TAG=latest
  fi
}

_deploy_app_runner() {
  printf '[5/5] Deploying to App Runner...\n'
  cd "$INFRA_DIR"
  local _AR_ARN _AR_REGION _AR_STATUS _TAINTED=0
  _AR_ARN="$(terraform output -raw apprunner_service_arn 2>/dev/null || true)"
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
  [[ "$_TAINTED" -eq 1 ]] && terraform apply -auto-approve -input=false

  printf '  Reading Terraform outputs...\n'
  APP_RUNNER_ARN="$(terraform output -raw apprunner_service_arn)"
  CDN_URL="$(terraform output -raw cdn_url)"
  CF_DIST_ID="$(terraform output -raw cf_distribution_id 2>/dev/null || true)"

  [[ "$FIRST_DEPLOY" == "0" ]] && _apprunner_deploy_existing
}

_apprunner_deploy_existing() {
  local status
  status="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
  if [[ "$status" == "OPERATION_IN_PROGRESS" ]]; then
    printf '  Deployment already in progress — waiting before starting ours...\n'
    local t0=$(date +%s)
    while [[ "$status" == "OPERATION_IN_PROGRESS" ]]; do
      sleep 20
      status="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
      printf '\r  %s... (%ds)' "$status" $(( $(date +%s) - t0 ))
    done
    printf '\n'
  fi

  if [[ "$_CH_PREWARMED" -eq 0 ]]; then
    _ch_wait_ready "[5/5]" "$CLICKHOUSE_URL" "$CH_PASS" 180 abort
  else
    printf '[5/5] ClickHouse confirmed reachable (pre-flight check passed).\n'
  fi

  aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
  local t0=$(date +%s) svc_status
  while true; do
    svc_status="$(aws apprunner describe-service --service-arn "$APP_RUNNER_ARN" --query 'Service.Status' --output text)"
    if [[ "$svc_status" == "RUNNING" ]]; then printf '\r  Running (%ds).  \n' $(( $(date +%s) - t0 )); break; fi
    if [[ "$svc_status" == "CREATE_FAILED" || "$svc_status" == "UPDATE_FAILED" ]]; then
      printf '\nERROR: App Runner %s.\n' "$svc_status"; exit 1
    fi
    printf '\r  %s... (%ds)' "$svc_status" $(( $(date +%s) - t0 ))
    sleep 20
  done
  printf '  Startup instrumentation complete — Redis and ClickHouse connections pre-warmed.\n'
}

_run_db_checks() {
  _ch_wait_ready "[deploy]" "$CLICKHOUSE_URL" "$CH_PASS" 180 skip

  _db_check_searchtext_case
  _db_check_notes
  _db_check_search_index
  _db_check_notes_ngram_idx
  _db_check_ocf
  _db_check_ocf_idx
  _db_check_daily_order_count
  _db_check_daily_search_token_summary
  _db_check_items_column
  _db_check_search_vocabulary
  _db_check_typesense
}

_db_check_searchtext_case() {
  printf '[deploy] Checking searchText case...\n'
  local _SEARCH_FIX
  _SEARCH_FIX="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
    --data-binary "SELECT if(lower(customerFirstName) != substring(searchText, 1, length(customerFirstName)), 1, 0) FROM orders LIMIT 1" \
    2>/dev/null || echo 0)"
  [[ "${_SEARCH_FIX:-0}" -eq 0 ]] && return 0

  printf '  Mixed-case searchText detected — submitting UPDATE...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders UPDATE searchText = concat(lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId), if(coalesce(notes, '') = '', '', concat(' ', coalesce(notes, ''))), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE lower(customerFirstName) != substring(searchText, 1, length(customerFirstName))" \
    2>/dev/null || true
  _poll_update_mutation
  printf '  Re-baking S3 dump with corrected data...\n'
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}" CLICKHOUSE_PASSWORD="$CH_PASS" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh"
}

_db_check_notes() {
  printf '[deploy] Checking notes content...\n'
  local _NULL_NOTES
  _NULL_NOTES="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT countIf(notes IS NULL) FROM orders" \
    2>/dev/null || echo 0)"
  [[ "${_NULL_NOTES:-0}" -eq 0 ]] && return 0

  printf '  %s rows with NULL notes — backfilling...\n' "$_NULL_NOTES"
  local _NOTES_POOL
  _NOTES_POOL="$(_sql_array "${DATA_DIR}/notes.txt")"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders UPDATE notes = arrayElement([${_NOTES_POOL}], toUInt32(intHash32(orderId) % 20) + 1), searchText = concat(lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId), ' ', arrayElement([${_NOTES_POOL}], toUInt32(intHash32(orderId) % 20) + 1), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE notes IS NULL" \
    2>/dev/null || true
  _poll_update_mutation
}

_db_check_search_index() {
  printf '[deploy] Checking search index...\n'
  local _IDX _IDX_PARTS _TOT_PARTS
  _IDX="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
    --data-binary "SELECT countIf(has(skip_indices, 'idx_search_fulltext')), count() FROM system.parts WHERE table='orders' AND active=1" \
    2>/dev/null || echo '0	1')"
  _IDX_PARTS="$(printf '%s' "$_IDX" | cut -f1)"
  _TOT_PARTS="$(printf '%s' "$_IDX" | cut -f2)"
  [[ "${_TOT_PARTS:-0}" -le 0 || "${_IDX_PARTS:-0}" -eq "${_TOT_PARTS}" ]] && return 0
  printf '  %s / %s parts indexed — materializing...\n' "${_IDX_PARTS:-0}" "${_TOT_PARTS:-?}"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders MATERIALIZE INDEX idx_search_fulltext" 2>/dev/null || true
  _poll_materialize_idx
}

_db_check_notes_ngram_idx() {
  printf '[deploy] Checking notes ngram index...\n'
  local _IDX _IDX_PARTS _TOT_PARTS
  _IDX="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
    --data-binary "SELECT countIf(has(skip_indices, 'idx_notes_ngram')), count() FROM system.parts WHERE table='orders' AND active=1" \
    2>/dev/null || echo '0	1')"
  _IDX_PARTS="$(printf '%s' "$_IDX" | cut -f1)"
  _TOT_PARTS="$(printf '%s' "$_IDX" | cut -f2)"
  [[ "${_TOT_PARTS:-0}" -le 0 || "${_IDX_PARTS:-0}" -eq "${_TOT_PARTS}" ]] && return 0
  printf '  %s / %s parts indexed — materializing idx_notes_ngram...\n' "${_IDX_PARTS:-0}" "${_TOT_PARTS:-?}"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders MATERIALIZE INDEX idx_notes_ngram" 2>/dev/null || true
  _poll_notes_ngram_idx
}

_db_check_ocf() {
  printf '[deploy] Checking order_category_facts...\n'
  local _FACTS_OK _FACTS_NOTES_OK _OCF_COUNT _ORDERS_COUNT _FACTS_OVERSIZED
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
    --data-binary "SELECT count() FROM order_category_facts" 2>/dev/null || echo 0)"
  _ORDERS_COUNT="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT count() FROM orders" 2>/dev/null || echo 0)"
  _FACTS_OVERSIZED="$(awk "BEGIN{print (${_OCF_COUNT:-0}+0 > (${_ORDERS_COUNT:-1}+0) * 1.2) ? 1 : 0}")"

  [[ "${_FACTS_OK:-0}" -ne 0 && "${_FACTS_NOTES_OK:-0}" -ne 0 && "${_FACTS_OVERSIZED:-0}" -eq 0 ]] && return 0

  if [[ "${_FACTS_OVERSIZED:-0}" -eq 1 ]]; then
    printf '  order_category_facts has %s rows vs %s orders — rebuilding from items array...\n' "${_OCF_COUNT}" "${_ORDERS_COUNT}"
  else
    printf '  Truncating and re-inserting order_category_facts (includes searchText)...\n'
  fi
  _db_rebuild_ocf
}

_db_rebuild_ocf() {
  printf '  [%s] Truncating chart summary tables...\n' "$(date +'%H:%M:%S')"
  local _SUMMARY_TABLE
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
  ( local _CH_URL="${CLICKHOUSE_URL}" _CH_PASS="${CH_PASS}"
    while true; do
      sleep 30
      local _OCF_NOW _PROC
      _OCF_NOW="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT count() FROM order_category_facts" 2>/dev/null || echo '?')"
      _PROC="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT round(elapsed,0), read_rows, written_rows FROM system.processes WHERE query LIKE 'INSERT INTO order_category_facts%' LIMIT 1" 2>/dev/null || echo '')"
      if [[ -n "${_PROC}" ]]; then
        printf '  [%s] INSERT running — elapsed=%ss  read=%s  written=%s  |  OCF so far: %s rows\n' \
          "$(date +'%H:%M:%S')" "$(printf '%s' "${_PROC}" | cut -f1)" \
          "$(printf '%s' "${_PROC}" | cut -f2)" "$(printf '%s' "${_PROC}" | cut -f3)" "${_OCF_NOW}"
      else
        printf '  [%s] INSERT no longer in system.processes  |  OCF: %s rows\n' "$(date +'%H:%M:%S')" "${_OCF_NOW}"
      fi
    done ) &
  local _OCF_PROG_PID=$!

  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "INSERT INTO order_category_facts (orderId, date, placedAt, customerId, regionId, regionCode, status, orderTotal, categoryId, categoryName, totalItems, totalRevenue, searchText) SELECT o.orderId, toDate(o.placedAt), o.placedAt, o.customerId, o.regionId, o.regionCode, o.status, o.total, item.categoryId, item.categoryName, item.quantity, toDecimal64(toFloat64(item.quantity) * toFloat64(item.unitPrice), 2), o.searchText FROM orders AS o ARRAY JOIN o.items AS item WHERE notEmpty(o.items) SETTINGS max_execution_time=7200" \
    2>/dev/null || true

  kill "${_OCF_PROG_PID}" 2>/dev/null || true
  wait "${_OCF_PROG_PID}" 2>/dev/null || true

  printf '  [%s] OCF INSERT complete — %s rows\n' "$(date +'%H:%M:%S')" \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM order_category_facts" 2>/dev/null || echo '?')"

  printf '  [%s] Forcing merge of chart summary tables (OPTIMIZE FINAL)...\n' "$(date +'%H:%M:%S')"
  local _SROW
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
}

_db_check_ocf_idx() {
  printf '[deploy] Checking idx_ocf_search index...\n'
  local _IDX _IDX_PARTS _TOT_PARTS
  _IDX="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
    --data-binary "SELECT countIf(has(skip_indices, 'idx_ocf_search')), count() FROM system.parts WHERE table='order_category_facts' AND active=1" \
    2>/dev/null || echo '0	1')"
  _IDX_PARTS="$(printf '%s' "$_IDX" | cut -f1)"
  _TOT_PARTS="$(printf '%s' "$_IDX" | cut -f2)"
  if [[ "${_TOT_PARTS:-0}" -gt 0 && "${_IDX_PARTS:-0}" -ne "${_TOT_PARTS}" ]]; then
    printf '  %s / %s parts indexed — materializing idx_ocf_search (~10 min for 50M rows)...\n' "${_IDX_PARTS:-0}" "${_TOT_PARTS:-?}"
    curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
      --data-binary "ALTER TABLE order_category_facts MATERIALIZE INDEX idx_ocf_search" 2>/dev/null || true
    _poll_ocf_idx
  else
    printf '  idx_ocf_search fully materialized (%s / %s parts) — skipping.\n' "${_IDX_PARTS:-0}" "${_TOT_PARTS:-?}"
  fi
}

_db_check_daily_order_count() {
  printf '[deploy] Checking daily_order_count...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "CREATE TABLE IF NOT EXISTS daily_order_count (date Date, regionId UInt32, regionCode LowCardinality(String), orderCount UInt64) ENGINE = SummingMergeTree(orderCount) ORDER BY (date, regionId)" \
    2>/dev/null || true
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_order_count TO daily_order_count AS SELECT toDate(placedAt) AS date, regionId, regionCode, toUInt64(1) AS orderCount FROM orders" \
    2>/dev/null || true
  local _DOC_COUNT
  _DOC_COUNT="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT sum(orderCount) FROM daily_order_count" 2>/dev/null || echo 0)"
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
}

_db_check_daily_search_token_summary() {
  printf '[deploy] Checking daily_search_token_summary...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "CREATE TABLE IF NOT EXISTS daily_search_token_summary (token LowCardinality(String), date Date, categoryName LowCardinality(String), orderCount UInt32, orderTotal Float64) ENGINE = MergeTree() ORDER BY (token, date, categoryName)" \
    2>/dev/null || true
  local _DSTS_COUNT
  _DSTS_COUNT="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT count() FROM daily_search_token_summary" 2>/dev/null || echo 0)"
  [[ "${_DSTS_COUNT:-0}" -ne 0 && "${_OCF_REBUILT:-0}" -eq 0 ]] && { printf '  daily_search_token_summary has %s rows — skipping.\n' "${_DSTS_COUNT}"; return 0; }

  printf '  [%s] Populating daily_search_token_summary from order_category_facts (~30 min)...\n' "$(date +'%H:%M:%S')"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=60" \
    --data-binary "TRUNCATE TABLE daily_search_token_summary" 2>/dev/null || true

  ( local _CH_URL="${CLICKHOUSE_URL}" _CH_PASS="${CH_PASS}"
    while true; do
      sleep 30
      local _NOW _PROC
      _NOW="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT count() FROM daily_search_token_summary" 2>/dev/null || echo '?')"
      _PROC="$(curl -sf -u "default:${_CH_PASS}" "${_CH_URL}/?default_format=TabSeparated&max_execution_time=5" \
        --data-binary "SELECT round(elapsed,0), read_rows, written_rows FROM system.processes WHERE query LIKE 'INSERT INTO daily_search_token_summary%' LIMIT 1" 2>/dev/null || echo '')"
      if [[ -n "${_PROC}" ]]; then
        printf '  [%s] token INSERT running — elapsed=%ss  read=%s  written=%s  |  rows so far: %s\n' \
          "$(date +'%H:%M:%S')" "$(printf '%s' "${_PROC}" | cut -f1)" \
          "$(printf '%s' "${_PROC}" | cut -f2)" "$(printf '%s' "${_PROC}" | cut -f3)" "${_NOW}"
      else
        printf '  [%s] token INSERT no longer in system.processes  |  rows: %s\n' "$(date +'%H:%M:%S')" "${_NOW}"
      fi
    done ) &
  local _PROG_PID=$!

  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "INSERT INTO daily_search_token_summary (token, date, categoryName, orderCount, orderTotal) SELECT tok AS token, date, categoryName, count() AS orderCount, sum(toFloat64(totalRevenue)) AS orderTotal FROM order_category_facts ARRAY JOIN splitByNonAlpha(lower(searchText)) AS tok WHERE length(tok) >= 2 GROUP BY tok, date, categoryName SETTINGS max_execution_time=7200" \
    2>/dev/null || true

  kill "${_PROG_PID}" 2>/dev/null || true
  wait "${_PROG_PID}" 2>/dev/null || true
  printf '  [%s] daily_search_token_summary populated: %s rows\n' "$(date +'%H:%M:%S')" \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" --data-binary "SELECT count() FROM daily_search_token_summary" 2>/dev/null || echo '?')"
}

_db_check_items_column() {
  printf '[deploy] Checking items column on orders...\n'
  local _ITEMS_POPULATED
  _ITEMS_POPULATED="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=60" \
    --data-binary "SELECT countIf(notEmpty(items)) FROM (SELECT items FROM orders LIMIT 1000000)" \
    2>/dev/null || echo 0)"
  [[ "${_ITEMS_POPULATED:-0}" -ne 0 ]] && return 0

  printf '  items column empty — submitting background migration (~2 h for 50M rows)...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "ALTER TABLE orders ADD COLUMN IF NOT EXISTS items Array(Tuple(categoryId UInt32, categoryName LowCardinality(String), productId UInt32, productName String, productSku LowCardinality(String), quantity UInt32, unitPrice Float64, discount Float64)) DEFAULT []" \
    2>/dev/null || true
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0&max_execution_time=30" \
    --data-binary "ALTER TABLE orders UPDATE items = [tuple(toUInt32(intHash32(toUInt32(orderId) * 3) % 200) + 1, concat('Category ', toString(toUInt32(intHash32(toUInt32(orderId) * 3) % 200) + 1)), toUInt32(intHash32(toUInt32(orderId) * 7) % 5000) + 1, concat('Product ', toString(toUInt32(intHash32(toUInt32(orderId) * 7) % 5000) + 1)), concat('SKU-', toString(toUInt32(intHash32(toUInt32(orderId) * 7) % 5000) + 1)), toUInt32(intHash32(toUInt32(orderId) * 11) % 3) + 1, 5.0 + toFloat64(intHash32(toUInt32(orderId) * 13)) / 4294967295.0 * 100.0, toFloat64(0))] WHERE empty(items)" \
    2>/dev/null || true
  printf '  mutation submitted (non-blocking).\n'
  _ITEMS_MIGRATION_PENDING=1
}

_db_check_search_vocabulary() {
  printf '[deploy] Checking search_vocabulary...\n'
  local _VOCAB_COUNT
  _VOCAB_COUNT="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT count() FROM search_vocabulary" 2>/dev/null || echo 0)"
  [[ "${_VOCAB_COUNT:-0}" -ne 0 ]] && return 0

  printf '  Populating search_vocabulary from orders.searchText...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "INSERT INTO search_vocabulary (token, doc_freq) SELECT token, count() AS doc_freq FROM (SELECT arrayJoin(splitByNonAlpha(lower(searchText))) AS token FROM orders) WHERE length(token) >= 2 AND NOT match(token, '^[0-9]+\$') GROUP BY token HAVING doc_freq >= 10" \
    2>/dev/null || true
  printf '  search_vocabulary populated: %s tokens\n' \
    "$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" --data-binary "SELECT count() FROM search_vocabulary" 2>/dev/null || echo '?')"
}

_db_check_typesense() {
  [[ -z "${TYPESENSE_URL:-}" || -z "${TYPESENSE_API_KEY:-}" ]] && return 0
  printf '[deploy] Checking Typesense collection...\n'
  local _TS_COL
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
  [[ "${_TS_COL:-0}" -ge 1000 ]] && { printf '  Typesense vocabulary already seeded — skipping.\n'; return 0; }

  printf '  Seeding Typesense vocabulary from search_vocabulary...\n'
  local _SEED_FILE="${ROOT_DIR}/.ts_seed.jsonl"
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=120" \
    --data-binary "SELECT token AS id, token, toInt32(doc_freq) AS doc_freq FROM search_vocabulary FORMAT JSONEachRow" \
    > "$_SEED_FILE" 2>/dev/null || true
  if [[ -s "$_SEED_FILE" ]]; then
    curl -sf -X POST "${TYPESENSE_URL}/collections/vocabulary/documents/import?action=upsert" \
      -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
      -H "Content-Type: text/plain" \
      --data-binary "@${_SEED_FILE}" 2>/dev/null | tail -1 >/dev/null || true
    local _TS_COUNT
    _TS_COUNT="$(curl -sf -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
      "${TYPESENSE_URL}/collections/vocabulary" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('num_documents',0))" 2>/dev/null || echo '?')"
    printf '  Seeding complete — %s tokens indexed\n' "${_TS_COUNT}"
  else
    printf '  Seed skipped (search_vocabulary empty — run deploy again after vocab is populated).\n'
  fi
  rm -f "$_SEED_FILE"
}

_prime_cdn_caches() {
  [[ -z "${CDN_URL:-}" ]] && return 0
  printf '\n  Priming CDN cache layers (90-day and all-time views)...\n'
  local _bounds _max_date _min_date _from90

  _bounds=$(curl -sf "${CDN_URL}/api/dataset-bounds" 2>/dev/null || true)
  _max_date=$(printf '%s' "$_bounds" | python3 -c "import sys,json; print(json.load(sys.stdin).get('to',''))" 2>/dev/null || true)
  _min_date=$(printf '%s' "$_bounds" | python3 -c "import sys,json; print(json.load(sys.stdin).get('from',''))" 2>/dev/null || true)
  if [[ -z "$_max_date" ]]; then
    _max_date=$(python3 -c "from datetime import date; print(date.today().isoformat())")
    printf '  (dataset-bounds unavailable — using today as fallback)\n'
  else
    printf '  dataset-bounds:              primed (%s → %s)\n' "$_min_date" "$_max_date"
  fi
  _from90=$(python3 -c "from datetime import date, timedelta; print((date.fromisoformat('${_max_date}') - timedelta(days=90)).isoformat())")

  curl -sf "${CDN_URL}/api/regions" >/dev/null \
    && printf '  regions:                     primed\n' || printf '  regions:                     skipped (not ready)\n'

  curl -sf "${CDN_URL}/api/aggregates?q=&from=${_from90}&to=${_max_date}&topCategories=4" >/dev/null \
    && printf '  aggregates/90d (top4):       primed\n' || printf '  aggregates/90d (top4):       skipped (not ready)\n'

  curl -sf "${CDN_URL}/api/aggregates?from=${_from90}&to=${_max_date}&topCategories=1" >/dev/null \
    && printf '  aggregates/90d (top1):       primed\n' || printf '  aggregates/90d (top1):       skipped (not ready)\n'

  if [[ -n "$_min_date" ]]; then
    curl -sf "${CDN_URL}/api/aggregates?q=&from=${_min_date}&to=${_max_date}&topCategories=4" >/dev/null \
      && printf '  aggregates/all-time (top4):  primed\n' || printf '  aggregates/all-time (top4):  skipped (not ready)\n'

    curl -sf "${CDN_URL}/api/aggregates?from=${_min_date}&to=${_max_date}&topCategories=1" >/dev/null \
      && printf '  aggregates/all-time (top1):  primed\n' || printf '  aggregates/all-time (top1):  skipped (not ready)\n'
  fi

  curl -sf "${CDN_URL}/api/orders?q=&page=1&pageSize=20&sort=placedAt&dir=desc&from=${_from90}&to=${_max_date}" >/dev/null \
    && printf '  orders/90d:                  primed\n' || printf '  orders/90d:                  skipped (not ready)\n'

  curl -sf "${CDN_URL}/api/orders?q=&page=1&pageSize=20&sort=placedAt&dir=desc&from=${_from90}&to=${_max_date}&facets=1" >/dev/null \
    && printf '  orders/90d+facets:           primed\n' || printf '  orders/90d+facets:           skipped (not ready)\n'

  curl -sf "${CDN_URL}/api/customers?limit=20" >/dev/null \
    && printf '  customers:                   primed\n' || printf '  customers:                   skipped (not ready)\n'
}

_finalize_deploy() {
  if [[ -n "${CF_DIST_ID:-}" ]]; then
    printf '  Invalidating CloudFront cache...\n'
    aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" \
      --query 'Invalidation.Id' --output text
  fi

  printf '\n  Dashboard:    %s\n' "$CDN_URL"
  printf '  API Explorer: %s/api-explorer\n' "$CDN_URL"
  printf '  Tear down:    %s/scripts/infra-down.sh\n' "$ROOT_DIR"

  _prime_cdn_caches

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

  if (( _IS_EC2_STACK == 0 )); then
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

  fi
}

_migrate_clickhouse_data() {
  local _OLD_URL _OLD_PASS _OLD_HOST
  _OLD_URL="$(grep '^OLD_CLICKHOUSE_URL=' "$CREDS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  _OLD_PASS="$(grep '^OLD_CLICKHOUSE_PASSWORD=' "$CREDS_FILE" 2>/dev/null | cut -d= -f2- || true)"

  [[ -z "$_OLD_URL" || -z "$_OLD_PASS" ]] && return 0
  [[ "$_OLD_URL" == "$CLICKHOUSE_URL" ]] && return 0

  _OLD_HOST="$(printf '%s' "$_OLD_URL" | sed 's|https://||;s|:8443||')"

  printf '[migrate] Checking ClickHouse data migration...\n'
  printf '  Source: %s\n' "$_OLD_URL"
  printf '  Target: %s\n' "$CLICKHOUSE_URL"

  local _OLD_PING
  _OLD_PING="$(curl -sf -u "default:${_OLD_PASS}" "${_OLD_URL}/?max_execution_time=10" \
    --data-binary "SELECT 1 FORMAT TSV" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$_OLD_PING" != "1" ]]; then
    printf '  WARNING: old service unreachable — skipping migration.\n'
    return 0
  fi

  local _OLD_CNT _NEW_CNT
  _OLD_CNT="$(curl -sf -u "default:${_OLD_PASS}" "${_OLD_URL}/?max_execution_time=30" \
    --data-binary "SELECT count() FROM orders FORMAT TSV" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  _NEW_CNT="$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "SELECT count() FROM orders FORMAT TSV" 2>/dev/null | tr -d '[:space:]' || echo 0)"

  if [[ "${_NEW_CNT:-0}" -gt 0 && "${_NEW_CNT:-0}" -eq "${_OLD_CNT:-0}" ]]; then
    printf '  Already migrated (%s orders). Skipping.\n' "$_OLD_CNT"
    return 0
  fi
  if [[ "${_NEW_CNT:-0}" -gt 0 && "${_NEW_CNT:-0}" -ne "${_OLD_CNT:-0}" ]]; then
    printf '  ERROR: partial migration detected (new=%s old=%s). Manual intervention required.\n' "$_NEW_CNT" "$_OLD_CNT"
    exit 1
  fi

  printf '  Migrating %s orders from old service...\n' "$_OLD_CNT"

  local _MURL="$CLICKHOUSE_URL" _MPASS="$CH_PASS"
  _mig() { curl -sf -u "default:${_MPASS}" "${_MURL}/?max_execution_time=${1}" --data-binary "${2}" 2>/dev/null || true; }

  printf '  [1/3] Applying schema (tables + indexes, no MVs)...\n'
  _mig 60 "CREATE TABLE IF NOT EXISTS categories (categoryId UInt32, name LowCardinality(String), slug LowCardinality(String), parentId Nullable(UInt32), createdAt DateTime64(3, 'UTC')) ENGINE = MergeTree() ORDER BY categoryId"
  _mig 60 "CREATE TABLE IF NOT EXISTS regions (regionId UInt32, code LowCardinality(String), name String, country String, timezone String) ENGINE = MergeTree() ORDER BY regionId"
  _mig 60 "CREATE TABLE IF NOT EXISTS customers (customerId UInt64, email String, firstName String, lastName String, phone Nullable(String), regionId UInt32, createdAt DateTime64(3, 'UTC')) ENGINE = MergeTree() ORDER BY customerId"
  _mig 60 "CREATE TABLE IF NOT EXISTS products (productId UInt32, sku String, name String, description Nullable(String), price Decimal(10,2), cost Decimal(10,2), stock UInt32, categoryId UInt32, createdAt DateTime64(3, 'UTC')) ENGINE = MergeTree() ORDER BY productId"
  _mig 60 "CREATE TABLE IF NOT EXISTS orders (orderId UInt64, customerId UInt64, regionId UInt32, regionCode LowCardinality(String), customerFirstName String, customerLastName String, customerEmail String, status LowCardinality(String), total Decimal(12,2), currency LowCardinality(String), notes Nullable(String), searchText String, placedAt DateTime64(3, 'UTC')) ENGINE = MergeTree() ORDER BY (placedAt, orderId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS order_items (itemId UInt64, orderId UInt64, productId UInt32, productName String, productSku LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), quantity UInt32, unitPrice Decimal(10,2), discount Decimal(5,2)) ENGINE = MergeTree() ORDER BY (orderId, itemId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS order_category_facts (orderId UInt64, date Date, placedAt DateTime64(3, 'UTC'), customerId UInt64, regionId UInt32, regionCode LowCardinality(String), status LowCardinality(String), orderTotal Decimal(12,2), categoryId UInt32, categoryName LowCardinality(String), totalItems UInt32, totalRevenue Decimal(14,2)) ENGINE = MergeTree() ORDER BY (date, orderId, categoryId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS daily_summary (date Date, categoryId UInt32, categoryName LowCardinality(String), regionId UInt32, regionCode LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems)) ORDER BY (date, regionId, categoryId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS daily_filter_category_summary (date Date, regionId UInt32, regionCode LowCardinality(String), status LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems)) ORDER BY (date, regionId, status, categoryId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS daily_status_category_summary (date Date, status LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems)) ORDER BY (date, status, categoryId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS daily_customer_category_summary (date Date, customerId UInt64, regionId UInt32, regionCode LowCardinality(String), status LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems)) ORDER BY (date, customerId, regionId, status, categoryId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS daily_order_count (date Date, regionId UInt32, regionCode LowCardinality(String), orderCount UInt64) ENGINE = SummingMergeTree(orderCount) ORDER BY (date, regionId)"
  _mig 60 "CREATE TABLE IF NOT EXISTS search_vocabulary (token LowCardinality(String), doc_freq UInt64) ENGINE = MergeTree ORDER BY token"
  _mig 60 "CREATE TABLE IF NOT EXISTS daily_search_token_summary (token LowCardinality(String), date Date, categoryName LowCardinality(String), orderCount UInt32, orderTotal Float64) ENGINE = MergeTree() ORDER BY (token, date, categoryName)"
  _mig 60 "ALTER TABLE orders ADD COLUMN IF NOT EXISTS itemCount UInt32 DEFAULT 0"
  _mig 60 "ALTER TABLE orders ADD COLUMN IF NOT EXISTS items Array(Tuple(categoryId UInt32, categoryName LowCardinality(String), productId UInt32, productName String, productSku LowCardinality(String), quantity UInt32, unitPrice Float64, discount Float64)) DEFAULT []"
  _mig 60 "ALTER TABLE order_category_facts ADD COLUMN IF NOT EXISTS searchText String DEFAULT ''"
  _mig 60 "ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_search_fulltext searchText TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1"
  _mig 60 "ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_notes_ngram notes TYPE text(tokenizer = ngrams(3)) GRANULARITY 1"
  _mig 60 "ALTER TABLE order_category_facts ADD INDEX IF NOT EXISTS idx_ocf_search searchText TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1"

  printf '  [2/3] Migrating data via remoteSecure...\n'
  local _T _TC _TABLES=(categories regions customers products order_items order_category_facts daily_summary daily_filter_category_summary daily_status_category_summary daily_customer_category_summary daily_order_count search_vocabulary daily_search_token_summary)
  for _T in "${_TABLES[@]}"; do
    _TC="$(curl -sf -u "default:${_OLD_PASS}" "${_OLD_URL}/?max_execution_time=30" \
      --data-binary "SELECT count() FROM ${_T} FORMAT TSV" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    printf '    %-50s %s rows...' "$_T" "$_TC"
    if [[ "${_TC:-0}" -eq 0 ]]; then printf ' empty, skipping.\n'; continue; fi
    curl -sf -u "default:${_MPASS}" "${_MURL}/?max_execution_time=7200" \
      --data-binary "INSERT INTO ${_T} SELECT * FROM remoteSecure('${_OLD_HOST}:9440', 'default', '${_T}', 'default', '${_OLD_PASS}') SETTINGS connect_timeout=30, receive_timeout=7200, send_timeout=7200" \
      2>/dev/null || { printf ' FAILED\n'; exit 1; }
    printf ' done.\n'
  done

  printf '    %-50s %s rows...' "orders" "$_OLD_CNT"
  curl -sf -u "default:${_MPASS}" "${_MURL}/?max_execution_time=7200" \
    --data-binary "INSERT INTO orders (orderId, customerId, regionId, regionCode, customerFirstName, customerLastName, customerEmail, status, total, currency, notes, searchText, placedAt, itemCount, items) SELECT orderId, customerId, regionId, regionCode, customerFirstName, customerLastName, customerEmail, status, total, currency, notes, searchText, placedAt, itemCount, items FROM remoteSecure('${_OLD_HOST}:9440', 'default', 'orders', 'default', '${_OLD_PASS}') SETTINGS connect_timeout=30, receive_timeout=7200, send_timeout=7200" \
    2>/dev/null || { printf ' FAILED\n'; exit 1; }
  printf ' done.\n'

  printf '  [3/3] Creating materialized views...\n'
  _mig 60 "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_summary TO daily_summary AS SELECT date, categoryId, categoryName, regionId, regionCode, toUInt64(1) AS totalOrders, totalRevenue, toUInt64(totalItems) AS totalItems FROM order_category_facts"
  _mig 60 "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_filter_category_summary TO daily_filter_category_summary AS SELECT date, regionId, regionCode, status, categoryId, categoryName, toUInt64(1) AS totalOrders, totalRevenue, toUInt64(totalItems) AS totalItems FROM order_category_facts"
  _mig 60 "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_status_category_summary TO daily_status_category_summary AS SELECT date, status, categoryId, categoryName, toUInt64(1) AS totalOrders, totalRevenue, toUInt64(totalItems) AS totalItems FROM order_category_facts"
  _mig 60 "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_customer_category_summary TO daily_customer_category_summary AS SELECT date, customerId, regionId, regionCode, status, categoryId, categoryName, toUInt64(1) AS totalOrders, totalRevenue, toUInt64(totalItems) AS totalItems FROM order_category_facts"
  _mig 60 "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_order_count TO daily_order_count AS SELECT toDate(placedAt) AS date, regionId, regionCode, toUInt64(1) AS orderCount FROM orders"

  printf '  [migrate] Complete.\n'
}

_deploy_cloud() {
  printf '\nFull deploy: Terraform + GH secret sync + migration + App Runner update.\n'
  printf 'Continue? [y/N]: '
  read -r _CLOUD_CONFIRM
  [[ "${_CLOUD_CONFIRM:-N}" =~ ^[Yy] ]] || { printf 'Aborted.\n'; exit 0; }
  _load_ch_creds
  _check_deps
  _sync_aws_gh_secrets
  _resolve_ch_endpoint
  _migrate_clickhouse_data
  _load_redis_creds
  _load_typesense_creds
  _provision_infra
  _verify_ecr_image
  _deploy_app_runner
  _run_db_checks
  _finalize_deploy
}

# ── Option 4: EC2-hosted ClickHouse ──────────────────────────────────────────

_ec2_ch_run() {
  local url="$1" pass="$2" sql="$3" timeout="${4:-60}"
  curl -sf -u "default:${pass}" "${url}/?max_execution_time=${timeout}" \
    --data-binary "$sql" 2>/dev/null
}

_ec2_provision() {
  printf '[ec2] Checking AWS credentials...\n'
  aws sts get-caller-identity >/dev/null

  EC2_PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24 || true)"

  printf '[ec2] Creating security group...\n'
  EC2_SG_ID="$(aws ec2 create-security-group \
    --group-name 'ch-dash-clickhouse' \
    --description 'ClickHouse for ch-dash' \
    --query 'GroupId' --output text)"
  aws ec2 authorize-security-group-ingress \
    --group-id "$EC2_SG_ID" \
    --protocol tcp --port 8123 --cidr 0.0.0.0/0 >/dev/null
  printf '  SG %s — port 8123 open\n' "$EC2_SG_ID"

  local _UD_FILE
  _UD_FILE="$(mktemp /tmp/ch-ec2-ud-XXXX.sh)"
  cat > "$_UD_FILE" <<USERDATA
#!/bin/bash
set -e
yum install -y yum-utils
yum-config-manager --add-repo https://packages.clickhouse.com/rpm/clickhouse.repo
yum install -y clickhouse-server clickhouse-client
mkdir -p /etc/clickhouse-server/config.d /etc/clickhouse-server/users.d
printf '<clickhouse><listen_host>0.0.0.0</listen_host></clickhouse>' \
  > /etc/clickhouse-server/config.d/network.xml
printf '<clickhouse><users><default><password>${EC2_PASS}</password></default></users></clickhouse>' \
  > /etc/clickhouse-server/users.d/password.xml
systemctl enable clickhouse-server
systemctl start clickhouse-server
USERDATA

  printf '[ec2] Launching t3.medium (100 GB gp3)...\n'
  local _JSON
  _JSON="$(aws ec2 run-instances \
    --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --instance-type t3.medium \
    --security-group-ids "$EC2_SG_ID" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":100,"VolumeType":"gp3"}}]' \
    --user-data "file://${_UD_FILE}" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=ch-dash-clickhouse}]' \
    --query 'Instances[0]' --output json)"
  EC2_INSTANCE_ID="$(printf '%s' "$_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['InstanceId'])")"
  rm -f "$_UD_FILE"

  printf '[ec2] Waiting for instance running (%s)...\n' "$EC2_INSTANCE_ID"
  aws ec2 wait instance-running --instance-ids "$EC2_INSTANCE_ID"
  EC2_IP="$(aws ec2 describe-instances \
    --instance-ids "$EC2_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  printf '[ec2] Instance at %s — waiting for ClickHouse (~3 min)...\n' "$EC2_IP"
  _ch_wait_ready "[ec2]" "http://${EC2_IP}:8123" "$EC2_PASS" 360 abort
  _ec2_run_ddl
}

_ec2_run_ddl() {
  printf '[ec2] Creating schema...\n'
  local _U="http://${EC2_IP}:8123" _P="$EC2_PASS"
  _ec2_ddl() { _ec2_ch_run "$_U" "$_P" "$1" 60 >/dev/null; }
  _ec2_ddl "CREATE TABLE IF NOT EXISTS categories (categoryId UInt32, name LowCardinality(String), slug LowCardinality(String), parentId Nullable(UInt32), createdAt DateTime64(3,'UTC')) ENGINE=MergeTree() ORDER BY categoryId"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS regions (regionId UInt32, code LowCardinality(String), name String, country String, timezone String) ENGINE=MergeTree() ORDER BY regionId"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS customers (customerId UInt64, email String, firstName String, lastName String, phone Nullable(String), regionId UInt32, createdAt DateTime64(3,'UTC')) ENGINE=MergeTree() ORDER BY customerId"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS products (productId UInt32, sku String, name String, description Nullable(String), price Decimal(10,2), cost Decimal(10,2), stock UInt32, categoryId UInt32, createdAt DateTime64(3,'UTC')) ENGINE=MergeTree() ORDER BY productId"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS orders (orderId UInt64, customerId UInt64, regionId UInt32, regionCode LowCardinality(String), customerFirstName String, customerLastName String, customerEmail String, status LowCardinality(String), total Decimal(12,2), currency LowCardinality(String), notes Nullable(String), searchText String, placedAt DateTime64(3,'UTC'), itemCount UInt32 DEFAULT 0, items Array(Tuple(categoryId UInt32, categoryName LowCardinality(String), productId UInt32, productName String, productSku LowCardinality(String), quantity UInt32, unitPrice Float64, discount Float64)) DEFAULT []) ENGINE=MergeTree() ORDER BY (placedAt, orderId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS order_items (itemId UInt64, orderId UInt64, productId UInt32, productName String, productSku LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), quantity UInt32, unitPrice Decimal(10,2), discount Decimal(5,2)) ENGINE=MergeTree() ORDER BY (orderId, itemId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS order_category_facts (orderId UInt64, date Date, placedAt DateTime64(3,'UTC'), customerId UInt64, regionId UInt32, regionCode LowCardinality(String), status LowCardinality(String), orderTotal Decimal(12,2), categoryId UInt32, categoryName LowCardinality(String), totalItems UInt32, totalRevenue Decimal(14,2), searchText String DEFAULT '') ENGINE=MergeTree() ORDER BY (date, orderId, categoryId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS daily_summary (date Date, categoryId UInt32, categoryName LowCardinality(String), regionId UInt32, regionCode LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE=SummingMergeTree((totalOrders,totalRevenue,totalItems)) ORDER BY (date,regionId,categoryId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS daily_filter_category_summary (date Date, regionId UInt32, regionCode LowCardinality(String), status LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE=SummingMergeTree((totalOrders,totalRevenue,totalItems)) ORDER BY (date,regionId,status,categoryId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS daily_status_category_summary (date Date, status LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE=SummingMergeTree((totalOrders,totalRevenue,totalItems)) ORDER BY (date,status,categoryId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS daily_customer_category_summary (date Date, customerId UInt64, regionId UInt32, regionCode LowCardinality(String), status LowCardinality(String), categoryId UInt32, categoryName LowCardinality(String), totalOrders UInt64, totalRevenue Decimal(14,2), totalItems UInt64) ENGINE=SummingMergeTree((totalOrders,totalRevenue,totalItems)) ORDER BY (date,customerId,regionId,status,categoryId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS daily_order_count (date Date, regionId UInt32, regionCode LowCardinality(String), orderCount UInt64) ENGINE=SummingMergeTree(orderCount) ORDER BY (date,regionId)"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS search_vocabulary (token LowCardinality(String), doc_freq UInt64) ENGINE=MergeTree ORDER BY token"
  _ec2_ddl "CREATE TABLE IF NOT EXISTS daily_search_token_summary (token LowCardinality(String), date Date, categoryName LowCardinality(String), orderCount UInt32, orderTotal Float64) ENGINE=MergeTree() ORDER BY (token,date,categoryName)"
  printf '  Schema ready.\n'
}

_ec2_transfer_data() {
  local _src_url _src_pass _cloud_host
  _src_url="$(grep '^CLICKHOUSE_URL=' "$CREDS_FILE" 2>/dev/null | cut -d= -f2-)"
  _src_pass="$(grep '^CLICKHOUSE_PASSWORD=' "$CREDS_FILE" 2>/dev/null | cut -d= -f2-)"
  [[ -z "$_src_url" || -z "$_src_pass" ]] && { printf 'ERROR: no Cloud credentials in .clickhouse-creds\n'; exit 1; }
  _cloud_host="$(printf '%s' "$_src_url" | sed 's|https://||; s|:.*||')"
  local _eu="http://${EC2_IP}:8123"

  _xfer() {
    local _tbl="$1" _timeout="${2:-3600}"
    printf '[ec2] Transferring %-44s' "${_tbl}..."
    local _t0 _cnt
    _t0=$(date +%s)
    _ec2_ch_run "$_eu" "$EC2_PASS" \
      "INSERT INTO ${_tbl} SELECT * FROM remoteSecure('${_cloud_host}:9440', default.${_tbl}, 'default', '${_src_pass}')" \
      "$_timeout" >/dev/null || true
    _cnt="$(_ec2_ch_run "$_eu" "$EC2_PASS" "SELECT count() FROM ${_tbl}" 10 || echo '?')"
    printf '%s rows (%ds)\n' "${_cnt:-?}" $(( $(date +%s) - _t0 ))
  }

  _xfer categories  120; _xfer regions 120; _xfer customers 300; _xfer products 120
  _xfer search_vocabulary 120; _xfer daily_search_token_summary 600
  _xfer orders 7200; _xfer order_items 7200; _xfer order_category_facts 7200
  _xfer daily_summary 600; _xfer daily_filter_category_summary 600
  _xfer daily_status_category_summary 600; _xfer daily_customer_category_summary 600
  _xfer daily_order_count 300

  printf '[ec2] OPTIMIZE FINAL on SummingMergeTree tables...\n'
  local _st
  for _st in daily_summary daily_filter_category_summary daily_status_category_summary daily_customer_category_summary daily_order_count; do
    printf '  %s...' "$_st"
    _ec2_ch_run "$_eu" "$EC2_PASS" "OPTIMIZE TABLE ${_st} FINAL" 300 >/dev/null || true
    printf ' done\n'
  done
}

_ec2_copy_ecr_image() {
  if _ecr_image_exists "latest"; then
    printf '[ec2] %s:latest already in ECR — skipping.\n' "$_ECR_REPO"
    return 0
  fi
  printf '[ec2] %s:latest not in ECR — triggering GH Actions to build and push it...\n' "$_ECR_REPO"
  if command -v gh >/dev/null 2>&1 && [[ -n "${_GH_REPO:-}" ]]; then
    if gh workflow run deploy.yml --repo "$_GH_REPO" 2>/dev/null; then
      printf '  Workflow triggered. Waiting for %s:latest to appear...\n' "$_ECR_REPO"
    else
      printf '  Could not trigger workflow — push a commit to main or re-run the last Actions job.\n'
    fi
  else
    printf '  gh CLI not available or _GH_REPO unset — push to main to trigger a build.\n'
  fi
}

_deploy_ec2_ch() {
  EC2_IP=""; EC2_PASS=""; EC2_INSTANCE_ID=""; EC2_SG_ID=""

  if [[ "$_EC2_PREFLIGHT_STATUS" == "reachable" ]]; then
    printf '[ec2] Found existing EC2 ClickHouse at %s — reachable.\n' "$_EC2_PREFLIGHT_IP"
    printf '  Use it (redeploy app only)? [Y/n]: '
    read -r _USE_EXISTING
    if [[ "${_USE_EXISTING:-Y}" =~ ^[Yy] ]]; then
      EC2_IP="$_EC2_PREFLIGHT_IP"
      EC2_PASS="$_EC2_PREFLIGHT_PASS"
      EC2_INSTANCE_ID="$_EC2_PREFLIGHT_INSTANCE_ID"
      EC2_SG_ID="$_EC2_PREFLIGHT_SG_ID"
    else
      _check_deps; _ec2_provision; _ec2_transfer_data
    fi

  elif [[ "$_EC2_PREFLIGHT_STATUS" == "unreachable" ]]; then
    printf '[ec2] Found .ec2-creds (IP: %s) but ClickHouse is NOT reachable.\n' "$_EC2_PREFLIGHT_IP"
    printf '  [1] Re-provision a fresh EC2 instance (recommended)\n'
    printf '  [2] Enter IP/password manually (instance may just be slow to respond)\n'
    printf '  [3] Abort\n'
    printf '  Choice [1/2/3, default 1]: '
    read -r _EC2_RECOVERY
    case "${_EC2_RECOVERY:-1}" in
      1) _check_deps; _ec2_provision; _ec2_transfer_data ;;
      2) printf 'EC2 IP or hostname: '; read -r EC2_IP
         printf 'ClickHouse password: '; read -rs EC2_PASS; printf '\n'
         EC2_INSTANCE_ID="$_EC2_PREFLIGHT_INSTANCE_ID"
         EC2_SG_ID="$_EC2_PREFLIGHT_SG_ID" ;;
      *) printf 'Aborting.\n'; exit 0 ;;
    esac

  else
    printf 'EC2 ClickHouse already exists? [y/N]: '
    read -r _EC2_EXISTS
    if [[ ! "${_EC2_EXISTS:-N}" =~ ^[Yy] ]]; then
      _check_deps; _ec2_provision; _ec2_transfer_data
    else
      printf 'EC2 IP or hostname: '
      read -r EC2_IP
      printf 'ClickHouse password: '
      read -rs EC2_PASS; printf '\n'
      if [[ -f "$ROOT_DIR/.ec2-creds" ]]; then
        EC2_INSTANCE_ID="$(grep '^EC2_INSTANCE_ID=' "$ROOT_DIR/.ec2-creds" 2>/dev/null | cut -d= -f2-)"
        EC2_SG_ID="$(grep '^EC2_SG_ID=' "$ROOT_DIR/.ec2-creds" 2>/dev/null | cut -d= -f2-)"
      fi
    fi
  fi

  local _CLOUD_URL
  _CLOUD_URL="$(grep '^CLICKHOUSE_URL=' "$CREDS_FILE" 2>/dev/null | cut -d= -f2- || true)"

  printf 'EC2_INSTANCE_ID=%s\nEC2_PUBLIC_IP=%s\nEC2_SG_ID=%s\nEC2_PASS=%s\nCH_CLOUD_URL_PREV=%s\n' \
    "$EC2_INSTANCE_ID" "$EC2_IP" "$EC2_SG_ID" "$EC2_PASS" "${_CLOUD_URL:-}" > "$ROOT_DIR/.ec2-creds"
  chmod 600 "$ROOT_DIR/.ec2-creds"

  printf 'CLICKHOUSE_URL=http://%s:8123\nCLICKHOUSE_USER=default\nCLICKHOUSE_PASSWORD=%s\n' \
    "$EC2_IP" "$EC2_PASS" > "$ROOT_DIR/.clickhouse-creds-ec2"
  chmod 600 "$ROOT_DIR/.clickhouse-creds-ec2"

  _IS_EC2_STACK=1
  _ECR_REPO="ch-dash-ec2-app"
  export TF_VAR_name_prefix="ch-dash-ec2"
  export CLICKHOUSE_URL="http://${EC2_IP}:8123"
  export CLICKHOUSE_PASSWORD="$EC2_PASS"
  export TF_VAR_clickhouse_url="$CLICKHOUSE_URL"
  export TF_VAR_clickhouse_password="$EC2_PASS"
  export CH_PASS="$EC2_PASS"

  cd "$INFRA_DIR"
  terraform workspace new ec2 2>/dev/null || terraform workspace select ec2

  _sync_aws_gh_secrets
  _load_redis_creds
  _load_typesense_creds
  _provision_infra
  _ec2_copy_ecr_image
  _verify_ecr_image
  _deploy_app_runner
  _run_db_checks

  local _EC2_CDN _CLOUD_CDN
  _EC2_CDN="$(terraform output -raw cdn_url 2>/dev/null || true)"
  terraform workspace select default >/dev/null 2>&1 || true
  _CLOUD_CDN="$(terraform output -raw cdn_url 2>/dev/null || true)"
  terraform workspace select ec2 >/dev/null 2>&1 || true

  _finalize_deploy

  terraform workspace select default >/dev/null 2>&1 || true

  printf '\n=== Parallel stacks running ===\n'
  printf '  ClickHouse Cloud: %s\n' "${_CLOUD_CDN:-[not deployed]}"
  [[ -n "${_CLOUD_CDN:-}" ]] && printf '    API Explorer:   %s/api-explorer\n' "$_CLOUD_CDN"
  printf '  EC2 ClickHouse:   %s\n' "${_EC2_CDN:-[not deployed]}"
  [[ -n "${_EC2_CDN:-}" ]] && printf '    API Explorer:   %s/api-explorer\n\n' "$_EC2_CDN" || printf '\n'
}

# ── Main ──────────────────────────────────────────────────────────────────────

_run_preflight

printf '\n=== %s deploy ===\n\n' "$PROJECT_NAME"
printf '  [1] Local  — npm run dev (port 3004)\n'
printf '  [2] Cloud  — GitHub Actions → ECR → App Runner (full: Terraform + DB checks)\n'
printf '  [3] %s\n' "${_OPTION3_LABEL:-Quick  — redeploy latest ECR image to App Runner (skips Terraform/DB)}"
printf '  [4] %s\n' "${_OPTION4_LABEL:-EC2    — deploy parallel EC2-backed stack (separate URL for side-by-side comparison)}"
printf '  [5] Both   — deploy Cloud (option 2) then EC2 (option 4) in sequence\n\n'
printf 'Choice [1/2/3/4/5, default %s]: ' "$_DEFAULT_CHOICE"
read -r DEPLOY_TARGET

printf 'Enable diagnostic logs? [y/N]: '
read -r _DIAG_CHOICE
if [[ "${_DIAG_CHOICE:-N}" =~ ^[Yy] ]]; then _DIAG_LOGS="1"; fi

printf 'Reuse all saved credentials (skip prompts)? [Y/n]: '
read -r _REUSE_CHOICE
if [[ "${_REUSE_CHOICE:-Y}" =~ ^[Yy] ]]; then _REUSE_CREDS="1"; fi

case "${DEPLOY_TARGET:-$_DEFAULT_CHOICE}" in
  1) _deploy_local ;;
  2) _deploy_cloud ;;
  3) _deploy_quick ;;
  4) _deploy_ec2_ch ;;
  5) _deploy_cloud; _deploy_ec2_ch ;;
  *) printf 'Invalid choice.\n'; exit 1 ;;
esac
