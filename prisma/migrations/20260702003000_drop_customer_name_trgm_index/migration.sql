-- Cleanup: idx_customers_name_trgm (added in 20260702001000) was a stopgap for
-- the old live-ILIKE search's 2-part ("firstName"||' '||"lastName") probe
-- query in orders.service.ts. That query no longer exists now that
-- orders.search_text (20260702002000_order_search_text) is the single source
-- of truth for order search — nothing queries this 2-part expression anymore.
-- idx_customers_trgm (3-part, includes email) is untouched: it still backs
-- /api/customers (customers.service.ts), a different feature not covered by
-- this change.
DROP INDEX IF EXISTS "idx_customers_name_trgm";
