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

---

## Transactional Outbox — Aggregate Upkeep

`createOrder` (`lib/services/orders.service.ts`) writes the order + its items **and** one
`order_events` outbox row in a single `prisma.$transaction` — no dual-write gap. A separate
process, `scripts/aggregates-worker.ts`, drains that table and performs the 7 aggregate-table
writes (`order_category_facts` + 6 `daily_*_summary`/`rollup` upserts) asynchronously, off the
request path. This replaced an earlier design where `createOrder` fired all 7 writes
synchronously/fire-and-forget, which could exhaust Prisma's connection pool under concurrent order
creation (a real `Timed out fetching a new connection from the connection pool` 500 was reproduced
and fixed by this change).

Key properties:
- **Atomic per event**: the worker claims one row via `SELECT ... FOR UPDATE SKIP LOCKED`, runs all
  7 updates, and marks it `processedAt` inside one transaction — a crash mid-processing rolls back
  cleanly and is safely retried, never double-counted.
- **Multi-worker safe**: `SKIP LOCKED` means running more than one worker instance against the same
  table never double-processes a row (horizontal scaling is safe by construction).
- **Fail-open with visibility**: failures increment `attempts`/`lastError` on the outbox row instead
  of silently vanishing (today's now-removed `.catch(() => {})` pattern could permanently
  undercount an aggregate with zero trace); capped at 5 attempts before a row is left for
  inspection.
- **The SSE live-feed (`publishOrderEvent` → `/api/stream`) is untouched** — it still fires
  immediately after the order commits, independent of the outbox/worker.
- Started automatically by `scripts/local-dev.sh` and `scripts/deploy.sh` (via
  `scripts/start-aggregates-worker.sh`, a pidfile + `nohup` process — same pattern as
  `scripts/start-bot.sh`). Manage it directly with `scripts/start-aggregates-worker.sh` /
  `stop-aggregates-worker.sh` / `restart-aggregates-worker.sh`.

### How a future agent should test this

1. **Confirm both processes are up**:
   ```bash
   lsof -nP -iTCP:3004 -sTCP:LISTEN                 # dashboard
   cat scripts/aggregates-worker.pid && ps -p "$(cat scripts/aggregates-worker.pid)" -o pid,command
   ```
   If the worker isn't running: `./scripts/start-aggregates-worker.sh` (no-op if already up).

2. **Concurrency no longer exhausts the pool** — the original bug this fixes. Fire a burst of
   concurrent creates and expect all `201`s, fast, with no `connection limit` 500s:
   ```bash
   for i in $(seq 1 15); do
     curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -X POST http://localhost:3004/api/orders \
       -H 'Content-Type: application/json' \
       -d '{"customerId":1,"regionId":1,"items":[{"productId":1,"quantity":2,"unitPrice":19.99}]}' &
   done; wait
   ```

3. **Outbox fills then drains** (LISTEN-driven, near-instant; 2s poll is the fallback):
   ```bash
   psql "$DATABASE_URL" -c 'SELECT id, "orderId", "processedAt", attempts FROM order_events ORDER BY id DESC LIMIT 15;'
   sleep 3
   psql "$DATABASE_URL" -c 'SELECT id, "orderId", "processedAt", attempts FROM order_events ORDER BY id DESC LIMIT 15;'
   # expect processedAt populated for all of them
   ```

4. **Aggregates reconcile exactly** — no double-counting, no missed rows. Compare the count of
   `order_category_facts` rows against the number of orders created in a known burst (should be
   equal):
   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM order_category_facts WHERE "orderId" IN (SELECT "orderId" FROM order_events WHERE id > <first_id_of_burst>);'
   ```

5. **`SKIP LOCKED` under two workers** — start a second, unmanaged instance alongside the
   pidfile-tracked one, fire a fresh burst, and confirm exactly N rows get `processedAt` set (not
   2N — that would mean double-processing):
   ```bash
   npx tsx scripts/aggregates-worker.ts > /tmp/worker2.log 2>&1 &
   WORKER2_PID=$!
   # ...fire a burst of N orders, then...
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM order_events WHERE "processedAt" IS NOT NULL AND id > <first_id_of_burst>;'
   kill "$WORKER2_PID"
   ```

6. **Crash recovery** — build a backlog (stop the worker first so it accumulates), hard-kill the
   worker (`kill -9 "$(cat scripts/aggregates-worker.pid)"`), confirm some rows may be
   `processedAt IS NULL` still, then `./scripts/start-aggregates-worker.sh` and confirm the backlog
   finishes draining with the aggregate delta still exactly N (not doubled, not short). Note: this
   worker drains fast (100+ events/sec observed), so catching it truly mid-transaction requires a
   large backlog (200+) and either a tight poll loop or an artificial delay — the atomicity
   guarantee itself is standard Postgres transaction semantics via `prisma.$transaction`, not
   something bespoke to verify from scratch each time.

### Verified baseline — treat as the regression threshold

These are the actual measured results from the session that built this feature, run against the
local `dashboard_perf` DB (~100k orders at the time). **A future change to this pipeline (schema,
worker loop, `createOrder`, or the 7 aggregate updaters) should reproduce results at least this
good** — if a re-run comes back slower or reconciles less exactly, treat that as a regression, not
noise.

| Check | Verified result |
|---|---|
| Concurrent order creation (was: 500 "connection limit: 9" at 3 concurrent, pre-fix) | 15 concurrent `POST /api/orders`, all `201`, **113ms–267ms** each, zero pool errors |
| Outbox drain latency | Backlogs of 15 / 30 / 100 / 187 / 263 orders all reached `processedAt` populated on **every** row within the 2s idle-poll window (LISTEN-driven drains were sub-second in practice) |
| Aggregate reconciliation (`order_category_facts` count vs. orders created) | Exact match at every burst size tested: 15/15, 30/30, 100/100, 187/187, 263/263 — zero discrepancy |
| Aggregate reconciliation (`daily_customer_category_summary.totalOrders` sum vs. orders created) | Exact match: 15/15 |
| `SKIP LOCKED` double-claim prevention | Two worker instances run concurrently against a 100-row backlog → exactly **100** rows marked `processedAt` (not 200) |
| Worker throughput (observed, not a hard guarantee) | A 187-row backlog was fully drained somewhere between 0.6s (0 processed) and 1.5s (187/187 processed) after worker start — i.e. **100+ events/sec** sustained, which is also why manufacturing a true mid-transaction crash test via a bash timing race proved impractical (see note above) |
| Backlog survives worker restarts | Stopped/restarted the worker several times over accumulated backlogs (up to 263 rows) — every restart fully drained the remainder with **no double-counted totals** in any run |
