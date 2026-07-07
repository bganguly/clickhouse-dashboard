-- One row per day, no category/status/region dimension, so a pure date-range
-- total can be summed from it without any risk of double-counting a
-- multi-category order (unlike daily_summary, which is per-category).
CREATE TABLE IF NOT EXISTS "daily_order_count" (
  "date"        date PRIMARY KEY,
  "totalOrders" integer NOT NULL DEFAULT 0
);

-- Backfill from existing orders.
INSERT INTO "daily_order_count" ("date", "totalOrders")
SELECT o."placedAt"::date, count(*)::int
FROM "orders" o
GROUP BY o."placedAt"::date
ON CONFLICT ("date") DO UPDATE SET "totalOrders" = EXCLUDED."totalOrders";
