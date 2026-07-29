const WARM_BATCH = 5;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { ensureCollection } = await import("@/lib/typesense");
  await ensureCollection().catch(() => {});

  const { listOrders } = await import("@/lib/services/orders.service");
  const { getDailyAggregates, getExactAggregateTotal } = await import("@/lib/services/aggregates.service");

  const today = () => new Date().toISOString().slice(0, 10);

  const baseAggInput = () => ({
    from: "2024-07-17", to: today(), q: null as string | null,
    status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4,
  });

  const warmAgg = (tok: string) => Promise.all([
    getDailyAggregates({ ...baseAggInput(), q: tok }),
    getExactAggregateTotal({ ...baseAggInput(), q: tok }),
  ]);

  const ping = async () => {
    try {
      await Promise.all([
        listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
        getDailyAggregates(baseAggInput()),
        getExactAggregateTotal(baseAggInput()),
      ]);
    } catch {}
  };

  const warmVisibleTokens = async () => {
    try {
      const firstPage = await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" });
      const rows = firstPage?.data ?? [];
      const totalBatches = Math.ceil(rows.length / WARM_BATCH);
      for (let i = 0; i < rows.length; i += WARM_BATCH) {
        const batch = rows.slice(i, i + WARM_BATCH);
        const batchNum = Math.floor(i / WARM_BATCH) + 1;
        const label = batch
          .map(r => `${r.customer.firstName} ${r.customer.lastName}${r.notes ? " " + r.notes : ""}`)
          .join(" | ");
        console.log(`[warmup] batch ${batchNum}/${totalBatches}: ${label}`);
        const seen = new Set<string>();
        const warmCalls = batch.flatMap(r => {
          const words = [r.customer.firstName, r.customer.lastName, r.notes ?? ""]
            .join(" ").split(/[^a-zA-Z]+/)
            .map(w => w.toLowerCase())
            .filter(w => w.length >= 3);
          const fresh = words.filter(w => !seen.has(w));
          fresh.forEach(w => seen.add(w));
          return fresh.flatMap(t => [
            listOrders({ q: t, page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
            warmAgg(t),
          ]);
        });
        await Promise.all(warmCalls);
      }
      console.log(`[warmup] done — ${rows.length} rows warmed`);
    } catch {}
  };

  void ping();
  setInterval(ping, 4 * 60 * 1000);

  void warmVisibleTokens();
  setInterval(warmVisibleTokens, 4 * 60 * 1000);
}
