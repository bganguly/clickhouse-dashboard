# clickhouse-dashboard

Next.js dashboard backed by ClickHouse Cloud (Development tier, auto-pause),
deployed on AWS App Runner behind CloudFront, with Upstash Redis and Typesense.

## Entry points

    ./scripts/deploy.sh      # provision + migrate + build + deploy (full or quick)
    ./scripts/infra-down.sh  # tear down infra

Never run terraform, aws, or clickhouse-client commands directly.

## Required env vars

    CLICKHOUSE_URL        https://<host>:8443
    CLICKHOUSE_USER       default
    CLICKHOUSE_PASSWORD   <password>
    CLICKHOUSE_CLOUD_KEY  <key-id>:<key-secret>
    REDIS_URL             rediss://default:<token>@<host>:6380
    TYPESENSE_HOST        <host>
    TYPESENSE_API_KEY     <key>

Optional:

    CLICKHOUSE_ORG_ID
    NEXT_PUBLIC_DIAG_LOGS   (set to any value to enable client + server diag logging)
    NEXT_PUBLIC_DEMO_SCALE

## Architecture

    lib/clickhouse.ts     thin client wrapper (query / execute / insert)
    lib/schema.ts         all DDL — CREATE TABLE IF NOT EXISTS + Materialized Views
    lib/services/         one file per domain; all queries go through lib/clickhouse.ts
    lib/redis.ts          Upstash Redis client
    lib/typesense.ts      Typesense autocomplete client
    instrumentation.ts    Next.js startup hook — pings Redis, ensures Typesense collection,
                          starts 8-min CH keepalive SELECT 1

Infra: Terraform (infra/main.tf) manages App Runner + ECR + CloudFront + IAM.
ClickHouse Cloud is managed via the CH Cloud REST API inside deploy.sh / infra-down.sh.

## Schema

Raw tables (MergeTree): orders, order_items, order_category_facts, categories, regions, customers, products
Aggregate tables (SummingMergeTree): daily_summary, daily_filter_category_summary,
  daily_status_category_summary, daily_customer_category_summary
Materialized Views fire on INSERT into order_category_facts (written by createOrder).

## Key patterns

- IDs: monotonic in-app counter (Date.now() seed + ++counter) — safe for single instance
- SSE: in-process EventEmitter (no LISTEN/NOTIFY), heartbeat every 25s
- Search: hasToken / positionCaseInsensitive on denormalized searchText column; Typesense for prefix expansion
- Pagination: keyset cursor (placedAt, orderId) for default sort; OFFSET for other sorts
- CDN caching: CloudFront caches /api/orders (s-maxage=300) and /api/aggregates (s-maxage=300, swr=600)
- Diag: NEXT_PUBLIC_DIAG_LOGS enables [perf:client] / [search-cache] / [agg-cache] / [ch] console logs

---

## Constraints — ask before violating any of these

### ClickHouse query budget
- The free tier has a strict compute quota. Never add ClickHouse queries to any
  high-frequency code path (called more than once per minute) without explicit approval.
- /api/health MUST NOT query ClickHouse. It is called every 30 s by App Runner.
  The instrumentation.ts keepalive (SELECT 1 every 8 min) is sufficient for CH warm-up.
- Do not shorten the App Runner health check interval below 30 s (infra/main.tf).

### Redis memory budget
- Upstash free tier hard limit: 256 MB. Safe operating budget: ≤ 150 MB.
- Redis is for small, bounded payloads only (row lists, IDs, counts).
- Never cache large aggregated datasets (charts, multi-dimensional rollups) in Redis.
  Large aggregates belong in in-process Maps with a MAX_ENTRIES bound.
- Cache warmup must be strictly bounded: top-100 tokens max per warmup phase.
- TTLs: list/row caches ≤ 5 min, aggregate/chart caches ≤ 10 min.
- Before adding a new cache layer or raising a token limit, estimate per-entry byte size
  × number of entries and confirm it fits within 150 MB.
- The Upstash instance must be in us-east-1 (same region as App Runner).

### topCategories / topN
- Never change the topCategories or topN cache key, default value, or lookup logic
  without explicit user approval.

### Performance
- Every dashboard response must complete in < 1 s end-to-end. A code path slower
  than 1 s is a bug, not a trade-off.
- Before switching a query from a pre-aggregated table to a live GROUP BY, stop and
  confirm the performance trade-off is acceptable.

### CDN caching
- CloudFront is used as a caching layer for API responses, not just static assets.
  Cache-Control headers on /api/orders and /api/aggregates must not be removed or
  reduced without approval.
- Never introduce approximate or estimated values (counts, totals) in place of exact
  data without explicit approval.

### Infra changes
- Any change to infra/main.tf requires a full deploy (option 2 in deploy.sh) to apply.
  Do not suggest running terraform directly.
