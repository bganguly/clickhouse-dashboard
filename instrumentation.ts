export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { ensureCollection } = await import("@/lib/typesense");
  await ensureCollection().catch(() => {});

  const { listOrders } = await import("@/lib/services/orders.service");
  const { getDailyAggregates } = await import("@/lib/services/aggregates.service");

  const today = () => new Date().toISOString().slice(0, 10);

  const ping = async () => {
    try {
      await Promise.all([
        listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
        getDailyAggregates({ from: "2020-01-01", to: today(), q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 5 }),
      ]);
    } catch {
      // best-effort keep-alive; swallow errors silently
    }
  };

  setInterval(ping, 4 * 60 * 1000);
}
