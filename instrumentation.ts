const CH_KEEPALIVE_MS = 8 * 60 * 1000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { query } = await import("@/lib/clickhouse");
  const { ensureCollection } = await import("@/lib/typesense");
  const { redis } = await import("@/lib/redis");

  await Promise.allSettled([
    ensureCollection(),
    redis?.ping(),
  ]);

  setInterval(() => {
    query("SELECT 1").catch(() => {});
  }, CH_KEEPALIVE_MS);

  void import("@/lib/services/aggregates.service").then(({ warmChartSvgs }) => warmChartSvgs().catch(() => {}));
}
