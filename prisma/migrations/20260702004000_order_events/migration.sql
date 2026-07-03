-- Transactional outbox for aggregate upkeep. createOrder writes one row here
-- in the same transaction as the order insert; scripts/aggregates-worker.ts
-- drains it asynchronously (FOR UPDATE SKIP LOCKED, one event per
-- transaction) instead of createOrder firing 7 aggregate upserts
-- synchronously/fire-and-forget in the request path.
CREATE TABLE IF NOT EXISTS "order_events" (
  "id"          serial PRIMARY KEY,
  "orderId"     integer NOT NULL,
  "processedAt" timestamp(3),
  "attempts"    integer NOT NULL DEFAULT 0,
  "lastError"   text,
  "createdAt"   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "order_events_order_id_idx"
  ON "order_events" ("orderId");

-- Partial index: only ever scans unprocessed rows, stays tiny regardless of
-- how large order_events grows. The worker's claim query
-- (WHERE "processedAt" IS NULL AND attempts < N ...) still uses this index.
CREATE INDEX IF NOT EXISTS "order_events_unprocessed_idx"
  ON "order_events" ("id")
  WHERE "processedAt" IS NULL;
