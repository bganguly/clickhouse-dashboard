# clickhouse-dashboard — Next.js + ClickHouse Cloud

Production-grade **Next.js 16 / TypeScript** orders dashboard backed by **ClickHouse Cloud** (Development tier, auto-pause). Sub-second full-text search and chart aggregates maintained by ClickHouse Materialized Views — no Prisma, no Postgres, no aggregates worker.

**[→ Portfolio demo](https://bganguly.github.io/?open=clickhouse)**

## Live Service URLs

| | |
|---|---|
| **Dashboard** | https://d1n8zhx1j8oymk.cloudfront.net |
| **API Explorer** | https://d1n8zhx1j8oymk.cloudfront.net/api-explorer |

> App Runner scales to zero when idle. First request after a cold start wakes the container (~5–10 s); subsequent requests are warm. A server-side keepalive in `instrumentation.ts` fires every 4 minutes to keep ClickHouse page cache warm while the container is running.

## Reference

| | |
|---|---|
| **[ClickHouse at 50 M rows](https://claude.ai/code/artifact/079e248c-2e53-4b02-ac1c-b4f3356ecb5f)** | Cost and performance brief |
| **[Performance remediation](https://claude.ai/code/artifact/907252f5-2595-4b55-9ad8-1760559aa9b4)** | 8-step plan — all steps complete · chart 6–14 s → 180 ms, search 5–8 s → <0.5 s |

---

## Stack

| | |
|---|---|
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS v4, Recharts |
| **Database** | ClickHouse Cloud (Development tier · auto-pause) via `@clickhouse/client` |
| **Search** | Typesense vocabulary index for prefix expansion → ClickHouse `hasToken` on denormalized `searchText` |
| **Aggregates** | ClickHouse Materialized Views + SummingMergeTree — maintained at INSERT time, no worker process |
| **IaC** | Terraform — App Runner + CloudFront (no EC2, no RDS) |
| **Deploy** | `./scripts/deploy.sh` — single entry point for infra + code |

---

## Schema design

Raw tables (MergeTree):

```
orders            — denormalized: customerFirstName/LastName/Email, regionCode, searchText
                    items: Array(Tuple(...)) — embedded, no join needed
order_category_facts  — one row per orderId × categoryId (ARRAY JOIN o.items); source for all MVs
categories / regions / customers / products
```

Aggregate tables (SummingMergeTree) populated by Materialized Views at INSERT time:

```
daily_summary
daily_filter_category_summary
daily_status_category_summary
daily_customer_category_summary
daily_search_token_summary      — per-token aggregation; drives <100 ms token search
```

MVs fire on INSERT into `order_category_facts` (written by `createOrder`). No background worker needed.

---

## Architecture

```
Browser ──HTTP──► CloudFront ──► App Runner (Next.js) ──@clickhouse/client──► ClickHouse Cloud
                                 scale-to-zero                                  (Development tier · HTTPS :8443)
                                 Terraform-managed

createOrder()
  ├─ INSERT orders (with items ARRAY)
  └─ INSERT order_category_facts  ──► 4 Materialized Views update aggregate tables
```

---

## Running

### Prerequisites

```
CLICKHOUSE_URL=https://your-service.clickhouse.cloud:8443
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=...
TYPESENSE_URL=http://your-typesense-host:8108
TYPESENSE_API_KEY=...
```

See `.env.example` for all variables.

### Deploy (provision infra + build + push to ECR + update App Runner)

```
./scripts/deploy.sh
```

Prompts for local dev (option 1) or cloud deploy (option 2, default). Cloud path: Terraform provisions App Runner + CloudFront; deploy.sh builds the Docker image, pushes to ECR, and triggers an App Runner deployment.

### Tear down

```
./scripts/infra-down.sh
```

Pauses the ClickHouse Cloud service (data preserved) and runs `terraform destroy` on App Runner + CloudFront.

---

## Cost

| Resource | Cost |
|---|---|
| App Runner | Scale-to-zero — ~$0 when idle; ~$0.064/vCPU-hr + $0.007/GB-hr when active |
| CloudFront | Negligible at demo traffic levels |
| ClickHouse Cloud Development tier | Auto-pauses after idle; ~$0 when paused |

---

## Key design decisions

| Concern | Approach |
|---|---|
| **Aggregates** | ClickHouse Materialized Views on `order_category_facts` → SummingMergeTree aggregate tables. No worker process, no outbox, no dual-write gap. |
| **Search** | Typesense holds vocabulary tokens (~50–200 k unique words). `expandPrefix()` maps partial input to the best full token; ClickHouse `hasToken` on the denormalized `searchText` column filters all 50 M orders correctly. No full-table LIKE scan. |
| **Pagination** | Keyset cursor `(placedAt, orderId)` for efficient deep pagination. |
| **IDs** | Monotonic in-app counter (seeded from `Date.now()`) — safe for single App Runner instance. |
| **Keepalive** | `instrumentation.ts` fires `listOrders` + `getDailyAggregates` every 4 minutes via `setInterval`, keeping ClickHouse page cache warm between user requests. |
