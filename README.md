# clickhouse-dashboard — Next.js + ClickHouse Cloud

Production-grade **Next.js 16 / TypeScript** full-stack orders dashboard delivering sub-second search
and chart responses across 50 M orders: full-text search via Typesense prefix expansion + ClickHouse
`hasToken`, pre-aggregated analytics via Materialized Views + SummingMergeTree, and Terraform IaC on AWS.

**[→ Portfolio demo](https://bganguly.github.io/?open=clickhouse)**

## Using the App

1. **Search** — type in the search bar to find orders by customer name or product; sub-second via Typesense prefix expansion + ClickHouse `hasToken` on a denormalized `searchText` column across 50 M orders.
2. **Aggregates** — the chart shows daily order totals by category from SummingMergeTree pre-aggregated tables; never touches raw orders.

---

| | |
|---|---|
| **Next.js / TypeScript full-stack** | Next.js 16, React 19, TypeScript, Tailwind CSS v4, Recharts |
| **ClickHouse Cloud — columnar analytics** | Development tier (auto-pause); ARRAY JOIN denormalization; 5 Materialized Views feeding SummingMergeTree aggregate tables; `hasToken` full-text search; 60 s query cache |
| **Search** | Typesense vocabulary index (~50–200 k tokens) for prefix expansion → ClickHouse `hasToken` on denormalized `searchText`; <0.5 s across 50 M orders |
| **IaC** | Terraform — App Runner + CloudFront |
| **CI/CD** | GitHub Actions → ECR → App Runner; ClickHouse schema migrations via `npx tsx` on each push to `main` |
| **Performance optimization** | SummingMergeTree + MVs collapse 50 M `order_category_facts` rows into pre-aggregated totals at INSERT time; `OPTIMIZE TABLE FINAL` forces immediate merge; query cache eliminates redundant ClickHouse round-trips |

---

## Scale & Performance

> **50 M orders** in ClickHouse Cloud — chart aggregates from SummingMergeTree pre-aggregated tables (**180 ms** cold after a [performance remediation](https://claude.ai/code/artifact/907252f5-2595-4b55-9ad8-1760559aa9b4) that collapsed 20 M unmerged rows); full-text search via Typesense + ClickHouse `hasToken` (**<0.5 s**).

```
Browser ──HTTP──► CloudFront ──► App Runner (Next.js) ──@clickhouse/client──► ClickHouse Cloud
                                 scale-to-zero                                  (Development tier · HTTPS :8443)
                                 Terraform-managed
```

---

## Running

```bash
./scripts/deploy.sh      # local dev [1] or cloud deploy [2]
./scripts/infra-down.sh  # pause ClickHouse service + terraform destroy
```

Prompts for local dev (option 1) or cloud deploy (option 2, default). Cloud path: Terraform provisions App Runner + CloudFront; GitHub Actions builds the Docker image, pushes to ECR, and App Runner deploys the new image automatically.

### Cost

| Resource | Cost |
|---|---|
| **App Runner** | Scale-to-zero — ~$0 when idle; ~$0.064/vCPU-hr + $0.007/GB-hr when active |
| **CloudFront** | Negligible at demo traffic levels |
| **ClickHouse Cloud Development tier** | Auto-pauses after idle; ~$0 when paused |

---

## Live Service

> App Runner scales to zero when idle. First request after a cold start wakes the container (~5–10 s); subsequent requests are warm. A server-side keepalive in `instrumentation.ts` fires every 4 minutes to keep ClickHouse page cache warm while the container is running.

| | |
|---|---|
| **Dashboard** | https://d1n8zhx1j8oymk.cloudfront.net |
| **API Explorer** | https://d1n8zhx1j8oymk.cloudfront.net/api-explorer |

```bash
BASE=https://d1n8zhx1j8oymk.cloudfront.net
curl "$BASE/api/orders?page=1&pageSize=3" | jq .total
curl "$BASE/api/orders?q=sara&page=1&pageSize=3" | jq '.data[].customer'
curl "$BASE/api/aggregates?from=2024-01-01&to=2024-12-31" | jq 'length'
```

---

## Architecture / Topology

```
┌───────────────────────────────────────────────────────────────────────────┐
│                               AWS Account                                 │
│                                                                           │
│   Terraform (infra/main.tf)                                               │
│   manages App Runner + CloudFront                                         │
│                                                                           │
│   ┌───────────────────────────────────────────────────────────────────┐   │
│   │  App Runner (Next.js · scale-to-zero)                             │   │
│   │  • REST /api/orders, /api/customers, /api/regions                 │   │
│   │  • /api/aggregates (chart — reads SummingMergeTree tables)        │   │
│   │  • instrumentation.ts keepalive (setInterval 4 min)               │   │
│   │  • @clickhouse/client over HTTPS :8443                            │   │
│   └──────────────────────────┬────────────────────────────────────────┘   │
│                              │ @clickhouse/client                         │
│   ┌───────────────────────────▼────────────────────────────────────────┐  │
│   │  ClickHouse Cloud (external · Development tier)                    │  │
│   │  • orders (50 M rows) + order_category_facts (50 M rows)          │  │
│   │  • categories / regions / customers / products                     │  │
│   │  • 5 Materialized Views → SummingMergeTree aggregate tables        │  │
│   │  • daily_search_token_summary — drives <100 ms token search        │  │
│   │  • hasToken full-text search on denormalized searchText column     │  │
│   │  • query_cache TTL 60 s on all analytics queries                   │  │
│   └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│   ECR — ch-dash-app:latest / ch-dash-app:<sha>                            │
│   GitHub Actions builds + pushes on every push to main                   │
└───────────────────────────────────────────────────────────────────────────┘

Deploy flow
───────────
local machine
  └─ deploy.sh
       ├─ terraform apply        → App Runner + CloudFront (first run)
       ├─ npx tsx migrations/    → ClickHouse schema (idempotent)
       ├─ scripts/seed.ts        → populate 50 M orders + OCF ARRAY JOIN (~2 hr)
       └─ docker build + push    → ECR :latest (App Runner auto-deploys)

GitHub Actions (.github/workflows/deploy.yml)
  └─ push to main
       ├─ docker build + push    → ECR :latest + :<sha>
       └─ npx tsx migrations/    → ClickHouse schema migrations
```

### Key design decisions

| Concern | Approach |
|---|---|
| **Aggregates** | ClickHouse Materialized Views on `order_category_facts` → SummingMergeTree aggregate tables. Updated synchronously at INSERT time; `OPTIMIZE TABLE FINAL` collapses unmerged parts for query performance. |
| **Search** | Typesense holds vocabulary tokens (~50–200 k unique words). `expandPrefix()` maps partial input to the best full token; ClickHouse `hasToken` on the denormalized `searchText` column filters all 50 M orders. |
| **Pagination** | Keyset cursor `(placedAt, orderId)` for efficient deep pagination — no OFFSET scans. |
| **IDs** | Monotonic in-app counter (seeded from `Date.now()`) — safe for single App Runner instance. |
| **Keepalive** | `instrumentation.ts` fires `listOrders` + `getDailyAggregates` every 4 minutes via `setInterval`, keeping ClickHouse page cache warm between user requests. |
| **Query cache** | `use_query_cache: 1, query_cache_ttl: 60` on all analytics queries — repeated calls return in ~10 ms. |

---

## Demo Data

Seeding 50 M orders takes ~2 hours via an ARRAY JOIN INSERT from `orders` into `order_category_facts`. `deploy.sh` detects existing data and skips the rebuild if `order_category_facts` is already populated:

```bash
./scripts/deploy.sh   # option 2 — seeds data on first run; skips if OCF already populated
```

After seeding, run `OPTIMIZE TABLE daily_summary FINAL` (and the other aggregate tables) in the ClickHouse Cloud console to force immediate part merges — otherwise SummingMergeTree deduplication is lazy and chart queries may read unmerged duplicates.

---

## Schema Design

Raw tables (MergeTree):

```
orders               — denormalized: customerFirstName/LastName/Email, regionCode, searchText
                       items: Array(Tuple(...)) — embedded
order_category_facts — one row per orderId × categoryId (ARRAY JOIN o.items); source for all MVs
categories / regions / customers / products
```

Aggregate tables (SummingMergeTree) populated by Materialized Views at INSERT into `order_category_facts`:

```
daily_summary                      — ORDER BY (date, regionId, categoryId)
daily_filter_category_summary      — ORDER BY (date, categoryId)
daily_status_category_summary      — ORDER BY (date, status, categoryId)
daily_customer_category_summary    — ORDER BY (date, customerId, categoryId)
daily_search_token_summary         — ORDER BY (token); drives <100 ms token search
```

MVs fire on INSERT into `order_category_facts`. The `daily_summary` fast path — `SUM(totalOrders) GROUP BY date, categoryName` — reads the 7.3 M fully-merged rows of `daily_summary` in **180 ms** cold / **~10 ms** cached.

---

## Reference

| | |
|---|---|
| **[ClickHouse at 50 M rows](https://claude.ai/code/artifact/079e248c-2e53-4b02-ac1c-b4f3356ecb5f)** | Cost and performance brief |
| **[Performance remediation](https://claude.ai/code/artifact/907252f5-2595-4b55-9ad8-1760559aa9b4)** | 8-step plan — all steps complete · chart 6–14 s → 180 ms, search 5–8 s → <0.5 s |
