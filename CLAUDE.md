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

Ordered as an incoming request encounters each layer: CDN → in-process mem → Redis → DB.
Instrumentation (startup, not on the hot path) is listed last.

### CDN (CloudFront — outermost, first layer an incoming request hits)
- CloudFront is a caching layer for API responses, not just static assets.
  Cache-Control headers on /api/orders and /api/aggregates must not be removed or
  reduced without approval.
- Never introduce approximate or estimated values (counts, totals) in place of exact
  data without explicit approval.
- deploy.sh already runs `aws cloudfront create-invalidation --paths "/*"` after
  every deploy (both option 2 and option 3). Do not add a second invalidation call.
- CDN cache key = exact URL including param order. The api-explorer fire-and-forget
  calls in app/api-explorer/page.tsx must use the exact same URL structure as the
  main UI (Chart.tsx / SearchTable.tsx) so CDN keys align. Canonical forms:
    /api/orders:     q=<term>&page=1&pageSize=20&sort=placedAt&dir=desc&from=2024-07-17&to=<today>
    /api/aggregates: from=2024-07-17&to=<today>&topCategories=4[&q=<term>]  (q always last)
  If you change how Chart.tsx or SearchTable.tsx builds its URL, update the
  fire-and-forget URLs in api-explorer/page.tsx to match.

### In-process cache (mem Map — first app-level layer after a CDN miss)
- Two separate Maps: search-cache.ts (orders rows + counts), aggregates-cache.ts
  (chart series + totals). Both capped at MAX_ENTRIES = 500.
- Cache keys are JSON-serialised param objects — URL param order is irrelevant.
- Large aggregated datasets belong here, NOT in Redis.
- Never change the topCategories / topN cache key or default without explicit approval.

### Redis (L2 cache — reached only after an in-process miss)
- Upstash Redis instance is in us-east-1, same region as App Runner. Cross-region
  latency is not a concern. Do not change the region without approval.
- Upstash free tier hard limit: 256 MB. Safe operating budget: ≤ 150 MB.
- Redis is for small, bounded payloads only (row lists, IDs, counts). Never cache
  large aggregated datasets in Redis.
- Cache warmup must be strictly bounded: top-100 tokens max per warmup phase.
- TTLs: list/row caches ≤ 5 min, aggregate/chart caches ≤ 10 min.
- Before adding a new cache layer or raising a token limit, estimate per-entry byte
  size × number of entries and confirm it fits within 150 MB.

### Cache key reference

CDN key = exact URL string (param order matters):

    /api/orders:     q=<term>&page=1&pageSize=20&sort=placedAt&dir=desc&from=2024-07-17&to=<today>
    /api/aggregates: from=2024-07-17&to=<today>&topCategories=4[&q=<term>]   ← q always last

In-process Map + Redis key = JSON-serialised param object (param order irrelevant):

    Data                 Key prefix + fields                                       from/to?
    ─────────────────────────────────────────────────────────────────────────────────────────
    Orders rows          search:rows:{q, page, pageSize, sort, dir, from, to, …}  YES
    Orders count         search:count:{q, statuses, regionCodes, from, to, …}     YES
    Aggregates series    agg:data:{q, status, topCategories, …}                   NO
    Aggregates total     agg:total:{q, status, topCategories, …}                  NO

Aggregates keys omit from/to intentionally — the same series is reused across date
ranges when q/filters/topN are identical. Orders keys include from/to because the
result rows change with the date window.

### DB (ClickHouse Cloud — reached only after all cache misses)
- The free tier has a strict compute quota. Never add ClickHouse queries to any
  code path called more than once per minute without explicit approval.
- Before switching a query from a pre-aggregated table to a live GROUP BY, stop and
  confirm the performance trade-off is acceptable.

### Instrumentation (startup — not on the hot request path)
- instrumentation.ts runs SELECT 1 every 8 min to keep ClickHouse warm. Do not
  add a second keepalive or shorten this interval without approval.
- /api/health MUST NOT query ClickHouse or Redis. It is polled every 30 s by
  App Runner; the keepalive above is sufficient for warm-up.
- Do not shorten the App Runner health check interval below 30 s (infra/main.tf).
- Every dashboard response must complete in < 1 s end-to-end. A code path slower
  than 1 s is a bug, not a trade-off.
- Any change to infra/main.tf requires a full deploy (option 2 in deploy.sh).
  Never run terraform directly.
