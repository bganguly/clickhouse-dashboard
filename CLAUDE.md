# clickhouse-dashboard

Next.js dashboard backed by ClickHouse Cloud (Development tier, auto-pause).
Replaces the nextjs-dashboard repo: no Postgres, no Prisma, no aggregates-worker.

## Entry points

Deploy (provision EC2 + ensure CH service + migrate + build + start):

    ./scripts/deploy.sh

Tear down (pause CH service + destroy EC2):

    ./scripts/infra-down.sh

Never run terraform, clickhouse-client, or pm2 commands directly.

## Required env vars

    CLICKHOUSE_URL        https://<host>:8443
    CLICKHOUSE_USER       default
    CLICKHOUSE_PASSWORD   <password>
    CLICKHOUSE_CLOUD_KEY  <key-id>:<key-secret>

Optional:

    CLICKHOUSE_ORG_ID       (auto-detected from API if omitted)
    CLICKHOUSE_SERVICE_NAME (default: clickhouse-dashboard)
    CLICKHOUSE_CLOUD_REGION (default: aws-us-east-1)
    CLICKHOUSE_CLOUD_TIER   (default: development)
    NEXT_PUBLIC_QUICK_ORDER_URL
    NEXT_PUBLIC_DEMO_SCALE

## Architecture

- lib/clickhouse.ts     thin client wrapper (query / execute / insert)
- lib/schema.ts         all DDL (CREATE TABLE IF NOT EXISTS + CREATE MATERIALIZED VIEW IF NOT EXISTS)
- lib/services/         one file per domain; all queries go through lib/clickhouse.ts
- No Prisma. No pg. No outbox. No aggregates-worker.

## Schema design

Raw tables (MergeTree):
  orders, order_items, order_category_facts, categories, regions, customers, products

Aggregate tables (SummingMergeTree) populated by Materialized Views at INSERT time:
  daily_summary, daily_filter_category_summary,
  daily_status_category_summary, daily_customer_category_summary

Materialized Views fire on INSERT into order_category_facts (written by createOrder).

## Key patterns

- IDs: monotonic in-app counter (Date.now() seed + ++counter) — safe for single instance
- SSE: in-process EventEmitter (no LISTEN/NOTIFY)
- Search: positionCaseInsensitive(searchText, ...) on denormalized searchText column
- Pagination: keyset cursor (placedAt, orderId) < ({cTs}, {cId})
- Warmup: /api/ch-warmup → SELECT 1; badge in dashboard header shows elapsed time
- No Docker. EC2 is Amazon Linux 2023, pm2 + nginx.

## Infra

Terraform manages EC2 only (VPC, subnets, IGW, EC2 t3.small, EIP, CloudFront).
ClickHouse Cloud is managed via the CH Cloud API inside deploy.sh / infra-down.sh.
