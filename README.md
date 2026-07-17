# clickhouse-dashboard — Next.js + ClickHouse Cloud

Production-grade **Next.js 16 / TypeScript** orders dashboard backed by **ClickHouse Cloud** (Development tier, auto-pause). Sub-second full-text search, real-time SSE updates, and chart aggregates maintained by ClickHouse Materialized Views — no Prisma, no Postgres, no aggregates worker.

**[→ Portfolio demo](https://bganguly.github.io/?open=clickhouse)**

## Live Service URLs&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[→ API Explorer walkthrough](https://claude.ai/code/artifact/079e248c-2e53-4b02-ac1c-b4f3356ecb5f)

| | |
|---|---|
| **Dashboard** | https://not-yet-deployed.example.com |
| **API Explorer** | https://not-yet-deployed.example.com/api-explorer |

---

## Stack

| | |
|---|---|
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS v4, Recharts |
| **Database** | ClickHouse Cloud (Development tier · auto-pause) via `@clickhouse/client` |
| **Aggregates** | ClickHouse Materialized Views + SummingMergeTree — maintained at INSERT time, no worker process |
| **Real-time** | Server-Sent Events (`/api/stream`) via in-process Node.js EventEmitter |
| **IaC** | Terraform — EC2 t3.small + VPC + CloudFront (no RDS) |
| **Deploy** | `./scripts/deploy.sh` — single entry point for infra + code |

---

## Schema design

Raw tables (MergeTree):

```
orders            — denormalized: customerFirstName/LastName/Email, regionCode, searchText
order_items       — denormalized: productName/Sku, categoryId/Name
order_category_facts  — one row per orderId × categoryId; source for all MVs
categories / regions / customers / products
```

Aggregate tables (SummingMergeTree) populated by Materialized Views at INSERT time:

```
daily_summary
daily_filter_category_summary
daily_status_category_summary
daily_customer_category_summary
```

MVs fire on INSERT into `order_category_facts` (written by `createOrder`). No background worker needed.

---

## Architecture

```
Browser ──HTTP──► Next.js (port 3004) ──@clickhouse/client──► ClickHouse Cloud
                  EC2 t3.small                                  (Development tier · HTTPS :8443)
                  behind CloudFront

createOrder()
  ├─ INSERT orders + order_items
  ├─ INSERT order_category_facts  ──► 4 Materialized Views update aggregate tables
  └─ publishOrderEvent()  ──► in-process EventEmitter ──► /api/stream (SSE)
```

```
Terraform manages: VPC · subnets · EC2 · EIP · CloudFront
deploy.sh manages: ClickHouse Cloud service lifecycle via CH Cloud API
```

---

## Running

### Prerequisites

```
CLICKHOUSE_URL=https://your-service.clickhouse.cloud:8443
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=...
CLICKHOUSE_CLOUD_KEY=<key-id>:<key-secret>
```

See `.env.example` for all variables.

### Deploy (provision + migrate + build + start)

```
./scripts/deploy.sh
```

This will:
1. Run `terraform apply` to ensure EC2 exists
2. Create the ClickHouse Cloud service (or resume if paused) via the CH Cloud API
3. Rsync code to EC2, run schema migrations (`CREATE TABLE IF NOT EXISTS` + `CREATE MATERIALIZED VIEW IF NOT EXISTS`), `npm run build`, start via pm2 + nginx

### Tear down

```
./scripts/infra-down.sh
```

Pauses the ClickHouse Cloud service (data preserved) and destroys EC2 via `terraform destroy`.

---

## Cost

| Resource | Cost |
|---|---|
| EC2 t3.small | ~$0.02/hr while running |
| ClickHouse Cloud Development tier | Auto-pauses after idle; ~$0 when paused |

---

## Key design decisions

| Concern | Approach |
|---|---|
| **Aggregates** | ClickHouse Materialized Views on `order_category_facts` → SummingMergeTree aggregate tables. No worker process, no outbox, no dual-write gap. |
| **Search** | `positionCaseInsensitive(searchText, token) > 0` on a denormalized `searchText` column on orders. No GIN index needed. |
| **Pagination** | Keyset cursor `(placedAt, orderId) < ({cTs}, {cId})` for efficient deep pagination. |
| **IDs** | Monotonic in-app counter (seeded from `Date.now()`) — safe for single EC2 instance. |
| **Real-time** | In-process Node.js `EventEmitter` replaces Postgres LISTEN/NOTIFY. Works on a single instance. |
| **Cold-start UX** | Warmup badge in dashboard header polls `/api/ch-warmup` on mount; shows elapsed seconds while ClickHouse is waking from auto-pause, then "Analytics ready" for 2s, then disappears. |
