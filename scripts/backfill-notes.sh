#!/usr/bin/env bash
# Backfill NULL notes on orders created before the pickNote() fix.
# Required env: CLICKHOUSE_URL, CLICKHOUSE_PASSWORD
# Optional:     CLICKHOUSE_USER (default: default)
set -euo pipefail

CH_URL="${CLICKHOUSE_URL:?CLICKHOUSE_URL not set}"
CH_USER="${CLICKHOUSE_USER:-default}"
CH_PASS="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD not set}"

_ch() {
  curl -sf -u "${CH_USER}:${CH_PASS}" \
    "${CH_URL}/?max_execution_time=7200" \
    --max-time 7260 \
    --data-binary @-
}

_query() {
  curl -sf -u "${CH_USER}:${CH_PASS}" \
    "${CH_URL}/?default_format=TabSeparated&max_execution_time=30" \
    --data-binary "$1"
}

NULL_COUNT=$(_query "SELECT count() FROM orders WHERE notes IS NULL")
printf 'orders with NULL notes: %s\n' "$NULL_COUNT"

if [ "$NULL_COUNT" -eq 0 ]; then
  printf 'Nothing to backfill.\n'
  exit 0
fi

printf 'Running backfill mutation...\n'

_ch <<'SQL'
ALTER TABLE orders
UPDATE
  notes = arrayElement([
    'please leave at front door ring bell twice',
    'gift wrapping requested include birthday card',
    'fragile items handle with extreme care',
    'corporate bulk order for quarterly offsite event',
    'express shipping required before the conference',
    'leave with building concierge if not home',
    'signature required upon delivery no exceptions',
    'urgent replacement for previously damaged shipment',
    'perishable contents keep refrigerated at all times',
    'eco friendly packaging only no plastic wrap',
    'annual office supply subscription renewal invoice',
    'school supply order for upcoming fall semester',
    'bridal shower gift please include congratulations card',
    'rush order needed before saturday morning delivery',
    'holiday promotional bundle seasonal discount applied',
    'wholesale distributor recurring weekly standing order',
    'loyalty rewards redemption free shipping included',
    'priority processing customer complaint credit applied',
    'temperature sensitive store below forty degrees fahrenheit',
    'military veteran discount applied thank you for service'
  ], toUInt32(intHash32(orderId) % 20) + 1),
  searchText = concat(
    lower(customerFirstName), ' ', lower(customerLastName), ' ', toString(orderId),
    ' ', arrayElement([
      'please leave at front door ring bell twice',
      'gift wrapping requested include birthday card',
      'fragile items handle with extreme care',
      'corporate bulk order for quarterly offsite event',
      'express shipping required before the conference',
      'leave with building concierge if not home',
      'signature required upon delivery no exceptions',
      'urgent replacement for previously damaged shipment',
      'perishable contents keep refrigerated at all times',
      'eco friendly packaging only no plastic wrap',
      'annual office supply subscription renewal invoice',
      'school supply order for upcoming fall semester',
      'bridal shower gift please include congratulations card',
      'rush order needed before saturday morning delivery',
      'holiday promotional bundle seasonal discount applied',
      'wholesale distributor recurring weekly standing order',
      'loyalty rewards redemption free shipping included',
      'priority processing customer complaint credit applied',
      'temperature sensitive store below forty degrees fahrenheit',
      'military veteran discount applied thank you for service'
    ], toUInt32(intHash32(orderId) % 20) + 1),
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
  )
WHERE notes IS NULL
SQL

printf 'Mutation submitted. ClickHouse runs mutations asynchronously.\n'
printf 'Check progress with:\n'
printf '  SELECT * FROM system.mutations WHERE table = '"'"'orders'"'"' AND is_done = 0\n'
