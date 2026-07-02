# Dashboard — Next.js + Prisma + AWS RDS

Production-grade **Next.js 16 / TypeScript** full-stack orders dashboard delivering sub-second search
and chart responses across 4 million orders: full-text trigram search, pre-aggregated analytics tables,
persistent count cache, Server-Sent Events for live updates, and Terraform IaC on AWS.

Sister repo: [websockets-quickorder](https://github.com/bganguly/websockets-quickorder)

---

| | |
|---|---|
| **Next.js / TypeScript full-stack** | Next.js 16, React 19, TypeScript, Tailwind CSS, Recharts |
| **PostgreSQL — SQL, performance tuning** | AWS RDS PG 16; Prisma migrations; GIN trigram index; pre-aggregated summary tables; persistent `count_cache` (10-min TTL) for sub-second pagination counts on 4 M rows |
| **IaC** | Terraform (`infra/main.tf`) — VPC, subnets, security groups, RDS PostgreSQL |
| **CI/CD** | `deploy.sh` — single entry point: provisions AWS infra if needed, applies Prisma schema + SQL migrations, builds and starts the app |
| **Real-time updates** | Server-Sent Events (`/api/stream`) — new orders pushed live to all connected dashboard tabs without polling |
| **Networking** | AWS VPC + public subnets; RDS locked to caller IP via security group |
| **Performance optimization** | Sub-second ILIKE via customer-id enumeration + GIN trigram index on customers; persistent `count_cache` eliminates repeat COUNT(*) scans; pre-agg tables for chart; startup warmup pre-seeds cache for first-page tokens |
| **System design diagrams** | See architecture section below |

---

## Scale & Performance

> **4 M+ orders** in AWS RDS PostgreSQL 16 — sub-second full-text search via customer-id enumeration + GIN trigram index; millisecond chart aggregates from pre-aggregated tables; `count_cache` removes the COUNT bottleneck on repeat queries.

```
Browser ──HTTP──► Next.js API routes ──Prisma──► AWS RDS PG 16
                  (port 3004)                    VPC · 4 M+ rows · GIN trigram index
                            ▲
             Terraform IaC (infra/main.tf)
```

---

## Local Dev

```bash
./scripts/local-dev.sh
```

Fully local — no AWS required. Uses a local Postgres database (`dashboard_local` by default).

On first run: creates the database, applies schema + SQL migrations, optionally seeds 4 M demo orders,
then starts on http://localhost:3004 with hot reload (`npm run dev`).

On subsequent runs: applies any pending migrations and starts immediately.

Prerequisites: `node` 18+, `psql`, local Postgres running (`brew install postgresql@16`).

Override the local DB name:
```bash
LOCAL_DB=my_db ./scripts/local-dev.sh
```

## Deploy (AWS RDS)

```bash
./scripts/deploy.sh
```

For cloud — provisions AWS RDS if not up, applies schema + SQL migrations, builds and starts the
production server (`npm run build && npm start`) on http://localhost:3004 pointed at remote RDS.

Prerequisites: `aws` CLI configured, `psql`, `node` 18+, `npx`.

---

## Live Service

| | URL |
|---|---|
| **Dashboard** | http://localhost:3004 (local) / `http://<ec2-ip>:3004` (deployed) |

### Quick test — local

```bash
curl "http://localhost:3004/api/orders?page=1&pageSize=3" | jq .total
curl "http://localhost:3004/api/orders?q=sara+frank&page=1&pageSize=3" | jq '.data[].customer'
curl "http://localhost:3004/api/aggregates?from=2024-01-01&to=2024-12-31" | jq 'length'
```

### Quick test — deployed

```bash
BASE=http://<ec2-ip>:3004   # address printed by deploy.sh after infra is up
curl "$BASE/api/orders?page=1&pageSize=3" | jq .total
curl "$BASE/api/orders?q=sara+frank&page=1&pageSize=3" | jq '.data[].customer'
curl "$BASE/api/aggregates?from=2024-01-01&to=2024-12-31" | jq 'length'
```

---

## Tear Down

```bash
./scripts/infra-down.sh
```

Destroys all AWS resources — RDS instance, VPC, subnets, security groups — and removes `.env.rds`.

> **Cost reminder:** `db.m5.xlarge` bills continuously while up (~$0.25/hr). Tear down when not in use.

---

## Architecture / Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              AWS Account                                │
│                                                                         │
│   Terraform (infra/main.tf)                                             │
│   manages all resources below                                           │
│                                                                         │
│   ┌───────────────────────────────────────────────────────────────┐     │
│   │                    dash-test-vpc (10.42.0.0/16)               │     │
│   │                                                               │     │
│   │   public-a / public-b subnets                                 │     │
│   │   ┌──────────────────────────────────────────────────────┐    │     │
│   │   │  Next.js (port 3004) — local process / future EC2    │    │     │
│   │   │  • REST /api/orders, /api/customers, /api/regions    │    │     │
│   │   │  • /api/aggregates (chart)                           │    │     │
│   │   │  • /api/stream  (SSE — live order events)            │    │     │
│   │   │  • Prisma $queryRaw + pre-agg table reads            │    │     │
│   │   └──────────────────────┬───────────────────────────────┘    │     │
│   │                          │ Prisma / pg                        │     │
│   │   ┌───────────────────────▼──────────────────────────────┐    │     │
│   │   │  AWS RDS PostgreSQL 16 (db.m5.xlarge)                │    │     │
│   │   │  • orders           (4 M rows)                       │    │     │
│   │   │  • customers + regions + products                    │    │     │
│   │   │  • GIN trigram index on customers(firstName,lastName)│    │     │
│   │   │  • pre-agg summary tables for chart queries          │    │     │
│   │   │  • count_cache (10-min TTL pagination counts)        │    │     │
│   │   │  • Prisma migrations V1–V11                          │    │     │
│   │   └──────────────────────────────────────────────────────┘    │     │
│   └───────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘

Deploy flow
───────────
local machine
  └─ deploy.sh
       ├─ database-url.sh → resolve DATABASE_URL (or run infra-up.sh)
       ├─ prisma db push   → sync schema to RDS
       ├─ psql migration.sql × N  → apply SQL migration files
       ├─ npm run build
       └─ npm start        → start Next.js on :3004

Real-time flow (SSE)
────────────────────
Quick Order (port 3005, bganguly/websockets-quickorder)
  └─ POST /api/orders → Next.js
       └─ publishOrderEvent()
            └─ /api/stream (SSE) → all open dashboard browser tabs refresh live
```

### Key design decisions

| Concern | Approach |
|---|---|
| **Search performance** | Customer-id enumeration (`SELECT id FROM customers WHERE name ILIKE`) then `customerId = ANY(ids)` join on orders — avoids full-table ILIKE scan; GIN trigram index on customers covers the probe |
| **Chart performance** | Pre-aggregated `daily_summary`, `daily_customer_category_summary`, `daily_status_category_summary`, `daily_filter_category_summary` — chart queries never touch raw orders |
| **Count performance** | Persistent `count_cache` table (10-min TTL) + startup warmup for first-page tokens — eliminates repeat COUNT(*) scans on 4 M rows |
| **Sort stability** | `placedAt DESC, id DESC` tiebreaker on all sort fields — prevents row duplication or skipping across pages |
| **Real-time** | SSE over HTTP long-poll — no WebSocket server needed; compatible with Next.js API routes; dashboard updates within ~100 ms of order creation |

---

## Snapshot / Demo Data

Seeding 4 M orders takes ~15-20 min. A maintainer can bake a `pg_dump` snapshot to a private S3
object and restore it in minutes:

```bash
# bake
DEMO_SNAPSHOT_S3_URI=s3://<bucket>/dash/demo.dump ./scripts/bake-demo-snapshot.sh

# restore (skips seed automatically)
DEMO_SNAPSHOT_S3_URI=s3://<bucket>/dash/demo.dump ./scripts/prepare-demo-data.sh
```

Developers cloning from GitHub have no S3 access and automatically fall back to the full seed path.
