#!/usr/bin/env bash
set -euo pipefail

[[ -z "${CLICKHOUSE_URL:-}" || -z "${CLICKHOUSE_PASSWORD:-}" ]] && { echo "CLICKHOUSE_URL / CLICKHOUSE_PASSWORD not set — skipping post-deploy."; exit 0; }

CH_PASS="$CLICKHOUSE_PASSWORD"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

_CH_DUMP_BUCKET="bikram-nextjs-subsecond-fetch-with-websockets"
_CH_DUMP_S3_KEY="clickhouse-dash/orders.parquet"
_CH_DUMP_S3_PREFIX="https://s3.us-east-1.amazonaws.com/${_CH_DUMP_BUCKET}/clickhouse-dash"

# ── Poll helpers ──────────────────────────────────────────────────────────────

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

_poll_count() {
  local table=$1 target=$2 pid=$3 t0 cur elapsed
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 10
    cur=$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM ${table}" 2>/dev/null || echo 0)
    elapsed=$(( $(date +%s) - t0 ))
    printf '\r  %s: %s / %s  elapsed: %ds' "$table" "${cur:-0}" "$target" "$elapsed"
  done
  printf '\n'
}

# ── Checks ────────────────────────────────────────────────────────────────────

_check_s3_dump() {
  printf '[post-deploy] Checking S3 Parquet dump...\n'
  if aws s3 ls "s3://${_CH_DUMP_BUCKET}/${_CH_DUMP_S3_KEY}" >/dev/null 2>&1; then
    printf '  Dump exists.\n'
  else
    printf '  No dump — baking 50M rows to S3...\n'
    CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
      bash "$ROOT_DIR/scripts/bake-ch-dump.sh"
  fi
}

_check_seed() {
  printf '[post-deploy] Checking demo data...\n'
  local _SEED_COUNT _PID _t0 _cur
  _SEED_COUNT="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary 'SELECT count() FROM orders' 2>/dev/null || echo 0)"
  if [[ "${_SEED_COUNT:-0}" -gt 0 ]]; then
    printf '  orders: %s rows — skipping seed.\n' "$_SEED_COUNT"
    return 0
  fi
  printf '  orders empty — seeding from S3 dump...\n'
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
  CH_DUMP_S3_PREFIX="$_CH_DUMP_S3_PREFIX" \
    bash "$ROOT_DIR/scripts/seed.sh" &
  _PID=$!
  _t0=$(date +%s)
  while kill -0 "$_PID" 2>/dev/null; do
    _cur=$(curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM orders" 2>/dev/null || echo 0)
    printf '\r  orders: %s / 50000000  elapsed: %ds' "${_cur:-0}" $(( $(date +%s) - _t0 ))
    sleep 10
  done
  printf '\n'
  wait "$_PID"
}

_check_names() {
  printf '[post-deploy] Checking name dictionary...\n'
  local _NAME_UNIQ
  _NAME_UNIQ="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT uniqExact(customerFirstName) FROM orders" 2>/dev/null || echo 0)"
  [[ "${_NAME_UNIQ:-0}" -ge 50 ]] && return 0
  printf '  Only %s distinct names — reseeding...\n' "$_NAME_UNIQ"
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CH_PASS" \
  SEED_FORCE=1 CH_DUMP_S3_PREFIX='' \
    bash "$ROOT_DIR/scripts/seed.sh"
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}" CLICKHOUSE_PASSWORD="$CH_PASS" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh"
}

_check_searchtext() {
  printf '[post-deploy] Checking searchText case...\n'
  local _SEARCH_FIX
  _SEARCH_FIX="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
    --data-binary "SELECT if(lower(customerLastName) != customerLastName, 1, 0) FROM orders LIMIT 1" \
    2>/dev/null || echo 0)"
  [[ "${_SEARCH_FIX:-0}" -eq 0 ]] && return 0
  printf '  Mixed-case names detected — submitting searchText UPDATE...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?mutations_sync=0" \
    --data-binary "ALTER TABLE orders UPDATE searchText = concat(lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId), if(coalesce(notes, '') = '', '', concat(' ', coalesce(notes, ''))), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE lower(customerLastName) != customerLastName" \
    2>/dev/null || true
  _poll_update_mutation
  printf '  Re-baking S3 dump with corrected data...\n'
  CLICKHOUSE_URL="$CLICKHOUSE_URL" CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}" CLICKHOUSE_PASSWORD="$CH_PASS" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh"
}

_check_index() {
  printf '[post-deploy] Checking search index...\n'
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

_check_ocf() {
  printf '[post-deploy] Checking order_category_facts...\n'
  local _FACTS _PID
  _FACTS="$(curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary 'SELECT count() FROM order_category_facts' 2>/dev/null || echo 0)"
  [[ "${_FACTS:-0}" -gt 0 ]] && return 0
  printf '  Backfilling order_category_facts...\n'
  curl -sf -u "default:${CH_PASS}" "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "
INSERT INTO order_category_facts
  (orderId, date, placedAt, customerId, regionId, regionCode,
   status, orderTotal, categoryId, categoryName, totalItems, totalRevenue)
SELECT o.orderId, toDate(o.placedAt), o.placedAt, o.customerId, o.regionId, o.regionCode,
  o.status, o.total, i.categoryId, i.categoryName, i.quantity,
  toDecimal64(toFloat64(i.quantity) * toFloat64(i.unitPrice), 2)
FROM orders AS o INNER JOIN order_items AS i ON i.orderId = o.orderId
" &
  _PID=$!
  _poll_count order_category_facts 50000000 "$_PID"
  wait "$_PID"
}

# ── Main ──────────────────────────────────────────────────────────────────────

_check_s3_dump
_check_seed
_check_names
_check_searchtext
_check_index
_check_ocf

printf '[post-deploy] Done.\n'
