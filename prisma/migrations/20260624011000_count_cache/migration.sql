CREATE TABLE IF NOT EXISTS count_cache (
  cache_key  TEXT        PRIMARY KEY,
  total      BIGINT      NOT NULL,
  cached_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
