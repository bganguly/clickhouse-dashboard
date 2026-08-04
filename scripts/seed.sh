#!/usr/bin/env bash
# Seed ClickHouse with demo data.
# Fast path: restore from S3 Parquet dump (CH_DUMP_S3_PREFIX + AWS_ACCESS_KEY_ID/SECRET).
# Slow path: INSERT SELECT from numbers() — all computation in ClickHouse Cloud, no local I/O.
# Required env: CLICKHOUSE_URL, CLICKHOUSE_PASSWORD
# Optional:     CLICKHOUSE_USER (default: default)
#               SEED_ORDERS     (default: 5000000)
#               SEED_FORCE=1    skip existing-row check
#               CH_DUMP_S3_PREFIX  e.g. https://s3.us-east-1.amazonaws.com/bucket/clickhouse-dash
#               AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (required for S3 fast path)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/data"

ORDERS="${SEED_ORDERS:-5000000}"
CUSTOMERS=200000
PRODUCTS=5000
CATEGORIES=200
REGIONS=50
DAYS_BACK=730

CH_URL="${CLICKHOUSE_URL:?CLICKHOUSE_URL not set}"
CH_USER="${CLICKHOUSE_USER:-default}"
CH_PASS="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD not set}"

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

_sql_array() {
  awk "BEGIN{ORS=\"\"} NR>1{print \",\"} {gsub(/'/, \"''\"); print \"'\" \$0 \"'\"}" "$1"
}

# ── Fast path: restore from S3 Parquet dump ──────────────────────────────────
S3_PREFIX="${CH_DUMP_S3_PREFIX:-}"
AWS_KEY="${AWS_ACCESS_KEY_ID:-}"
AWS_SECRET="${AWS_SECRET_ACCESS_KEY:-}"

_try_s3_restore() {
  [[ -n "$S3_PREFIX" && -n "$AWS_KEY" && -n "$AWS_SECRET" ]] || return 1

  printf 'Checking S3 dump at %s...\n' "$S3_PREFIX"
  local check
  check="$(curl -sf -u "${CH_USER}:${CH_PASS}" \
    "${CH_URL}/?default_format=TabSeparated&max_execution_time=60" \
    --data-binary "SELECT count() FROM s3('${S3_PREFIX}/orders.parquet', '${AWS_KEY}', '${AWS_SECRET}', 'Parquet') LIMIT 1" \
    2>/dev/null || echo 0)"
  [[ "${check:-0}" -gt 0 ]] || { printf '  S3 dump not found or not readable — falling back to generate.\n'; return 1; }

  printf 'Restoring from S3 dump (%s rows in orders)...\n' "$check"

  printf '  Truncating tables...\n'
  for tbl in order_category_facts daily_summary daily_filter_category_summary \
             daily_status_category_summary daily_customer_category_summary \
             order_items orders customers products categories regions; do
    _ch <<<"TRUNCATE TABLE IF EXISTS ${tbl}"
  done

  for tbl in regions categories products customers orders order_items; do
    printf '  restoring %s...\n' "$tbl"
    _ch <<<"INSERT INTO ${tbl} SELECT * FROM s3('${S3_PREFIX}/${tbl}.parquet', '${AWS_KEY}', '${AWS_SECRET}', 'Parquet')"
  done

  printf '  restoring order_category_facts (fires aggregate MVs)...\n'
  _ch <<<"INSERT INTO order_category_facts SELECT * FROM s3('${S3_PREFIX}/order_category_facts.parquet', '${AWS_KEY}', '${AWS_SECRET}', 'Parquet')"

  printf '\nRestore complete:\n'
  printf '  orders:               %s\n' "$(_count orders)"
  printf '  order_items:          %s\n' "$(_count order_items)"
  printf '  order_category_facts: %s\n' "$(_count order_category_facts)"
  printf '  daily_summary:        %s\n' "$(_count daily_summary)"
  return 0
}

# ── Slow path helpers ─────────────────────────────────────────────────────────
_seed_reference_tables() {
  printf '  Truncating tables...\n'
  for tbl in order_category_facts daily_summary daily_filter_category_summary \
             daily_status_category_summary daily_customer_category_summary \
             order_items orders customers products categories regions; do
    _ch <<<"TRUNCATE TABLE IF EXISTS ${tbl}"
  done

  printf '  regions...\n'
  _ch <<SQL
INSERT INTO regions (regionId, code, name, country, timezone)
SELECT number + 1,
       concat('R', toString(number + 1)),
       concat('Region ', toString(number + 1)),
       'US',
       'America/New_York'
FROM numbers(${REGIONS})
SQL

  printf '  categories...\n'
  _ch <<SQL
INSERT INTO categories (categoryId, name, slug, createdAt)
SELECT number + 1,
       concat('Category ', toString(number + 1)),
       concat('category-', toString(number + 1)),
       now64()
FROM numbers(${CATEGORIES})
SQL

  printf '  products...\n'
  _ch <<SQL
INSERT INTO products (productId, sku, name, price, cost, stock, categoryId, createdAt)
SELECT number + 1,
       concat('SKU-', toString(number + 1)),
       concat('Product ', toString(number + 1)),
       toDecimal64(round(5.0 + (rand() / 4294967295.0) * 100.0, 2), 2),
       toDecimal64(round(2.0 + (rand() / 4294967295.0) * 50.0, 2), 2),
       toUInt32(rand() % 500),
       toUInt32((number % ${CATEGORIES}) + 1),
       now64()
FROM numbers(${PRODUCTS})
SQL
}

_seed_customers() {
  local first_names_arr last_names_arr
  first_names_arr="$(_sql_array "${DATA_DIR}/first_names.txt")"
  last_names_arr="$(_sql_array "${DATA_DIR}/last_names.txt")"

  printf '  customers (%s)...\n' "$CUSTOMERS"
  _ch <<SQL
INSERT INTO customers (customerId, email, firstName, lastName, regionId, createdAt)
SELECT number + 1,
       concat('customer', toString(number + 1), '@example.com'),
       arrayElement([${first_names_arr}], toUInt32((number % 3186) + 1)),
       arrayElement([${last_names_arr}], toUInt32((number % 473) + 1)),
       toUInt32((rand() % ${REGIONS}) + 1),
       now64()
FROM numbers(${CUSTOMERS})
SQL
}

_seed_orders() {
  local first_names_arr last_names_arr notes_arr
  first_names_arr="$(_sql_array "${DATA_DIR}/first_names.txt")"
  last_names_arr="$(_sql_array "${DATA_DIR}/last_names.txt")"
  notes_arr="$(_sql_array "${DATA_DIR}/notes.txt")"

  printf '  orders (%s)...\n' "$ORDERS"
  _ch <<SQL
INSERT INTO orders
  (orderId, customerId, regionId, regionCode,
   customerFirstName, customerLastName, customerEmail,
   status, total, currency, notes, searchText, placedAt, itemCount, items)
SELECT
  number + 1                                                                                       AS orderId,
  cust_id,
  reg_id,
  concat('R', toString(reg_id))                                                                    AS regionCode,
  arrayElement([${first_names_arr}], toUInt32((cust_id % 3186) + 1))                              AS customerFirstName,
  arrayElement([${last_names_arr}], toUInt32((cust_id % 473) + 1))                                AS customerLastName,
  concat('customer', toString(cust_id), '@example.com')                                           AS customerEmail,
  arrayElement(['PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED'],
               toUInt32((rand() % 7) + 1))                                                        AS status,
  toDecimal64(round(10.0 + (rand() / 4294967295.0) * 500.0, 2), 2)                               AS total,
  'USD'                                                                                            AS currency,
  arrayElement([${notes_arr}], toUInt32(intHash32(number + 1) % 20) + 1)                         AS notes,
  concat(
    lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId),
    concat(' ', arrayElement([${notes_arr}], toUInt32(intHash32(number + 1) % 20) + 1)),
    if(length(customerFirstName) > 3,
      concat(' ', arrayStringConcat(
        arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName),
          arrayMap(i -> lower(substring(customerFirstName, 1, i)),
            range(1, length(customerFirstName) + 1)
          )
        ), ' '
      )),
      ''
    ),
    if(length(customerLastName) > 3,
      concat(' ', arrayStringConcat(
        arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName),
          arrayMap(i -> lower(substring(customerLastName, 1, i)),
            range(1, length(customerLastName) + 1)
          )
        ), ' '
      )),
      ''
    )
  )                                                                                                AS searchText,
  toDateTime64(now64() - toIntervalSecond(toUInt64(rand()) % toUInt64(${DAYS_BACK} * 86400)), 3, 'UTC') AS placedAt,
  toUInt32(1)                                                                                           AS itemCount,
  [tuple(
    toUInt32(intHash32(toUInt32(number + 1) * 3) % ${CATEGORIES}) + 1,
    concat('Category ', toString(toUInt32(intHash32(toUInt32(number + 1) * 3) % ${CATEGORIES}) + 1)),
    toUInt32(intHash32(toUInt32(number + 1) * 7) % ${PRODUCTS}) + 1,
    concat('Product ', toString(toUInt32(intHash32(toUInt32(number + 1) * 7) % ${PRODUCTS}) + 1)),
    concat('SKU-', toString(toUInt32(intHash32(toUInt32(number + 1) * 7) % ${PRODUCTS}) + 1)),
    toUInt32(intHash32(toUInt32(number + 1) * 11) % 3) + 1,
    5.0 + toFloat64(intHash32(toUInt32(number + 1) * 13)) / 4294967295.0 * 100.0,
    toFloat64(0)
  )]                                                                                                    AS items
FROM (
  SELECT
    number,
    toUInt64((rand() % ${CUSTOMERS}) + 1) AS cust_id,
    toUInt32((rand() % ${REGIONS}) + 1)   AS reg_id
  FROM numbers(${ORDERS})
)
SQL

  printf '  order_items (%s)...\n' "$ORDERS"
  _ch <<SQL
INSERT INTO order_items
  (itemId, orderId, productId, productName, productSku, categoryId, categoryName, quantity, unitPrice, discount)
SELECT
  number + 1                                                          AS itemId,
  number + 1                                                          AS orderId,
  prod_id,
  concat('Product ', toString(prod_id))                              AS productName,
  concat('SKU-', toString(prod_id))                                  AS productSku,
  cat_id,
  concat('Category ', toString(cat_id))                              AS categoryName,
  toUInt32((rand() % 3) + 1)                                        AS quantity,
  toDecimal64(round(5.0 + (rand() / 4294967295.0) * 100.0, 2), 2)  AS unitPrice,
  toDecimal64(0, 2)                                                  AS discount
FROM (
  SELECT
    number,
    toUInt32((rand() % ${PRODUCTS}) + 1)    AS prod_id,
    toUInt32((rand() % ${CATEGORIES}) + 1)  AS cat_id
  FROM numbers(${ORDERS})
)
SQL
}

_seed_ocf() {
  printf '  order_category_facts + aggregate MVs...\n'
  _ch <<SQL
INSERT INTO order_category_facts
  (orderId, date, placedAt, customerId, regionId, regionCode,
   status, orderTotal, categoryId, categoryName, totalItems, totalRevenue, searchText)
SELECT
  o.orderId,
  toDate(o.placedAt)                                                                    AS date,
  o.placedAt,
  o.customerId,
  o.regionId,
  o.regionCode,
  o.status,
  o.total                                                                               AS orderTotal,
  item.categoryId,
  item.categoryName,
  item.quantity                                                                         AS totalItems,
  toDecimal64(toFloat64(item.quantity) * toFloat64(item.unitPrice), 2)                 AS totalRevenue,
  o.searchText
FROM orders AS o
ARRAY JOIN o.items AS item
WHERE notEmpty(o.items)
SQL
}

_seed_vocabulary() {
  printf '  search_vocabulary...\n'
  _ch <<SQL
INSERT INTO search_vocabulary (token, doc_freq)
SELECT token, count() AS doc_freq
FROM (
  SELECT arrayJoin(splitByNonAlpha(lower(searchText))) AS token
  FROM orders
)
WHERE length(token) >= 2 AND NOT match(token, '^[0-9]+\$')
GROUP BY token
HAVING doc_freq >= 10
SQL
}

# ── Entry point ───────────────────────────────────────────────────────────────
ORDER_COUNT="$(_count orders 2>/dev/null || echo 0)"
if [[ "${ORDER_COUNT:-0}" -gt 0 && "${SEED_FORCE:-0}" != "1" ]]; then
  printf 'orders already has %s rows — skipping seed.\n' "$ORDER_COUNT"
  exit 0
fi

if _try_s3_restore; then
  exit 0
fi

printf 'Seeding %s orders (%s customers / %s products / %s categories / %s regions)...\n' \
  "$ORDERS" "$CUSTOMERS" "$PRODUCTS" "$CATEGORIES" "$REGIONS"

_seed_reference_tables
_seed_customers
_seed_orders
_seed_ocf
_seed_vocabulary

printf '\nSeed complete:\n'
printf '  orders:               %s\n' "$(_count orders)"
printf '  order_items:          %s\n' "$(_count order_items)"
printf '  order_category_facts: %s\n' "$(_count order_category_facts)"
printf '  daily_summary:        %s\n' "$(_count daily_summary)"
printf '  search_vocabulary:    %s\n' "$(_count search_vocabulary)"
