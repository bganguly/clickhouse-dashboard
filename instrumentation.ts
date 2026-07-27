const WARM_TOKENS = 100;
const WARM_BATCH  = 10;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { ensureCollection } = await import("@/lib/typesense");
  await ensureCollection().catch(() => {});

  const { listOrders } = await import("@/lib/services/orders.service");
  const { getDailyAggregates } = await import("@/lib/services/aggregates.service");
  const { query } = await import("@/lib/clickhouse");

  const today = () => new Date().toISOString().slice(0, 10);

  const ping = async () => {
    try {
      await Promise.all([
        listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
        getDailyAggregates({ from: "2020-01-01", to: today(), q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4 }),
      ]);
    } catch {}
  };

  const warmTopTokens = async () => {
    try {
      const rows = await query<{ token: string }>(
        `SELECT lower(customerLastName) AS token FROM orders
         GROUP BY customerLastName ORDER BY count() DESC LIMIT ${WARM_TOKENS}`,
      );
      const tokens = rows.map(r => r.token).filter(Boolean);
      for (let i = 0; i < tokens.length; i += WARM_BATCH) {
        await Promise.all(
          tokens.slice(i, i + WARM_BATCH).map(tok =>
            listOrders({ q: tok, page: 1, pageSize: 10, sort: "placedAt", dir: "desc" }),
          ),
        );
      }
    } catch {}
  };

  // Baseline warm at startup, then every 4 min
  void ping();
  setInterval(ping, 4 * 60 * 1000);

  // Top-N token warm at startup (server-side, before any browser request lands)
  // then every 4 min so caches stay hot between intervals
  void warmTopTokens();
  setInterval(warmTopTokens, 4 * 60 * 1000);
}
