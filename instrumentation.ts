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
    from: "2020-01-01", to: today(), q: null as string | null,
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
      const visibleSet = new Set<string>();
      for (const row of firstPage?.data ?? []) {
        const text = [row.customer.firstName, row.customer.lastName, row.notes ?? ""].join(" ");
        for (const w of text.split(/[^a-zA-Z]+/)) {
          const t = w.toLowerCase();
          if (t.length >= 3) visibleSet.add(t);
        }
      }
      const tokens = [...visibleSet];
      const totalBatches = Math.ceil(tokens.length / WARM_BATCH);
      for (let i = 0; i < tokens.length; i += WARM_BATCH) {
        const batch = tokens.slice(i, i + WARM_BATCH);
        const batchNum = Math.floor(i / WARM_BATCH) + 1;
        console.log(`[warmup] batch ${batchNum}/${totalBatches}: ${batch.join(", ")}`);
        await Promise.all(batch.flatMap(t => [
          listOrders({ q: t, page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
          warmAgg(t),
        ]));
      }
      console.log(`[warmup] done — ${tokens.length} tokens warmed`);
    } catch {}
  };

  void ping();
  setInterval(ping, 4 * 60 * 1000);

  void warmVisibleTokens();
  setInterval(warmVisibleTokens, 4 * 60 * 1000);
}
