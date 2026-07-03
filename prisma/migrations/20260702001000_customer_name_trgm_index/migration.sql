-- The orders/aggregates text search (orders.service.ts, aggregates.service.ts)
-- filters on ("firstName" || ' ' || "lastName") — no email. That expression
-- doesn't match idx_customers_trgm (which includes email, for the /api/customers
-- autocomplete in customers.service.ts), so Postgres falls back to a sequential
-- scan of customers on every uncached search. Add a dedicated index for the
-- name-only expression so both callers get an index-backed bitmap scan.
CREATE INDEX IF NOT EXISTS "idx_customers_name_trgm" ON "customers"
  USING gin (("firstName" || ' ' || "lastName") gin_trgm_ops);
