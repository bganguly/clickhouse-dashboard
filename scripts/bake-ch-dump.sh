#!/usr/bin/env bash
# Generate 50M demo rows in ClickHouse Cloud and export each table to S3 as Parquet.
# Heavy work runs entirely inside ClickHouse Cloud — no local disk or EC2 disk used.
# Required env: CLICKHOUSE_URL, CLICKHOUSE_PASSWORD
# AWS credentials from environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
#   or ~/.aws/credentials via `aws configure`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

S3_BUCKET="${CH_DUMP_BUCKET:-bikram-nextjs-subsecond-fetch-with-websockets}"
S3_PREFIX="${CH_DUMP_PREFIX:-clickhouse-dash}"
AWS_REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

CH_URL="${CLICKHOUSE_URL:?CLICKHOUSE_URL not set}"
CH_USER="${CLICKHOUSE_USER:-default}"
CH_PASS="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD not set}"

AWS_KEY="${AWS_ACCESS_KEY_ID:-$(aws configure get aws_access_key_id 2>/dev/null || true)}"
AWS_SECRET="${AWS_SECRET_ACCESS_KEY:-$(aws configure get aws_secret_access_key 2>/dev/null || true)}"
[[ -n "$AWS_KEY" && -n "$AWS_SECRET" ]] || { printf 'ERROR: AWS credentials not found in env or ~/.aws/credentials.\n'; exit 1; }

S3_BASE="https://s3.${AWS_REGION}.amazonaws.com/${S3_BUCKET}/${S3_PREFIX}"

_ch() {
  curl -sf -u "${CH_USER}:${CH_PASS}" \
    "${CH_URL}/?max_execution_time=7200" \
    --max-time 7260 \
    --data-binary @-
}

_count() {
  curl -sf -u "${CH_USER}:${CH_PASS}" \
    "${CH_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "SELECT count() FROM ${1}"
}

# 1 — Reseed to 50M (ClickHouse Cloud generates all data server-side)
ORDER_COUNT="$(_count orders)"
if [[ "${ORDER_COUNT:-0}" -ge 50000000 ]]; then
  printf 'orders already has %s rows — skipping reseed.\n' "$ORDER_COUNT"
else
  printf 'Reseeding to 50M orders (current: %s)...\n' "$ORDER_COUNT"
  CLICKHOUSE_URL="$CH_URL" \
  CLICKHOUSE_USER="$CH_USER" \
  CLICKHOUSE_PASSWORD="$CH_PASS" \
  SEED_ORDERS=50000000 \
  SEED_FORCE=1 \
    bash "$ROOT_DIR/scripts/seed.sh"
fi

# 2 — Export tables to S3 (ClickHouse Cloud writes directly to S3, no local I/O)
printf '\nExporting to s3://%s/%s/ (ClickHouse → S3, no local transfer)...\n' "$S3_BUCKET" "$S3_PREFIX"

for tbl in regions categories products customers orders order_items order_category_facts; do
  rows="$(_count "$tbl")"
  printf '  %-30s %s rows...\n' "$tbl" "$rows"
  _ch <<SQL
INSERT INTO FUNCTION s3(
  '${S3_BASE}/${tbl}.parquet',
  '${AWS_KEY}', '${AWS_SECRET}',
  'Parquet'
)
SELECT * FROM ${tbl}
SQL
done

printf '\nDump complete: s3://%s/%s/\n' "$S3_BUCKET" "$S3_PREFIX"
printf 'Restore URI:   CH_DUMP_S3_PREFIX=%s\n' "$S3_BASE"
