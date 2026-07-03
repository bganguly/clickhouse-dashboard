-- Denormalized search_text column on orders — ports GCP's V4__search_text.sql.
-- Single GIN-trigram index covers every visible list column (customer name,
-- notes, total, order id, status, region code/name, placed date), so a
-- multi-word search becomes a per-token ILIKE AND chain against ONE indexed
-- column instead of joining/probing customers and notes separately.
-- Idempotent: safe to run against an already-partially-migrated dev DB.

-- 1. Column (nullable at the DB level; BEFORE INSERT/UPDATE trigger below
--    always overwrites it, so application code never needs to supply it).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "search_text" TEXT;

-- 2. One-time backfill. Only touches rows not yet populated, so safe to re-run.
UPDATE "orders" o
SET "search_text" =
  c."firstName" || ' ' || c."lastName" || ' ' ||
  COALESCE(o.notes, '') || ' ' ||
  o.total::text || ' ' ||
  o.id::text || ' ' ||
  o.status::text || ' ' ||
  r.code || ' ' || r.name || ' ' ||
  o."placedAt"::date::text
FROM "customers" c, "regions" r
WHERE c.id = o."customerId"
  AND r.id = o."regionId"
  AND o."search_text" IS NULL;

-- 3. GIN trigram index. pg_trgm already enabled by
--    20260622000000_orders_search_indexes; CREATE EXTENSION line kept for
--    idempotent standalone-runnability.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_orders_search_text_trgm"
  ON "orders" USING gin ("search_text" gin_trgm_ops);

-- 4. Keep search_text in sync on every order insert/update.
CREATE OR REPLACE FUNCTION fn_order_search_text() RETURNS TRIGGER AS $$
DECLARE
  v_first text; v_last text; v_rcode text; v_rname text;
BEGIN
  SELECT "firstName", "lastName" INTO v_first, v_last
    FROM "customers" WHERE id = NEW."customerId";
  SELECT code, name INTO v_rcode, v_rname
    FROM "regions" WHERE id = NEW."regionId";
  NEW."search_text" :=
    v_first || ' ' || v_last || ' ' ||
    COALESCE(NEW.notes, '') || ' ' ||
    NEW.total::text || ' ' ||
    NEW.id::text || ' ' ||
    NEW.status::text || ' ' ||
    v_rcode || ' ' || v_rname || ' ' ||
    NEW."placedAt"::date::text;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CREATE OR REPLACE TRIGGER requires PG14+; confirmed server is PG16.14.
CREATE OR REPLACE TRIGGER trgr_order_search_text
  BEFORE INSERT OR UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION fn_order_search_text();

-- 5. Propagate a customer name change onto all of that customer's orders.
CREATE OR REPLACE FUNCTION fn_customer_name_to_orders() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."firstName" IS DISTINCT FROM NEW."firstName" OR
     OLD."lastName"  IS DISTINCT FROM NEW."lastName" THEN
    UPDATE "orders" o
    SET "search_text" =
      NEW."firstName" || ' ' || NEW."lastName" || ' ' ||
      COALESCE(o.notes, '') || ' ' ||
      o.total::text || ' ' ||
      o.id::text || ' ' ||
      o.status::text || ' ' ||
      r.code || ' ' || r.name || ' ' ||
      o."placedAt"::date::text
    FROM "regions" r
    WHERE o."customerId" = NEW.id AND r.id = o."regionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trgr_customer_search_text
  AFTER UPDATE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION fn_customer_name_to_orders();
