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

  const baseAggInput = () => ({
    from: "2020-01-01", to: today(), q: null as string | null,
    status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4,
  });

  const warmBoth = (tok: string) => Promise.all([
    listOrders({ q: tok, page: 1, pageSize: 10, sort: "placedAt", dir: "desc" }),
    getDailyAggregates({ ...baseAggInput(), q: tok }),
  ]);

  const ping = async () => {
    try {
      await Promise.all([
        listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
        getDailyAggregates(baseAggInput()),
      ]);
    } catch {}
  };

  const warmTopTokens = async () => {
    try {
      // Priority 1: every full word visible on the default first page (name + notes)
      const firstPage = await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" });
      const visibleSet = new Set<string>();
      for (const row of firstPage?.data ?? []) {
        const text = [row.customer.firstName, row.customer.lastName, row.notes ?? ""].join(" ");
        for (const w of text.split(/[^a-zA-Z]+/)) {
          const t = w.toLowerCase();
          if (t.length >= 3) visibleSet.add(t);
        }
      }
      const visibleTokens = [...visibleSet];
      for (let i = 0; i < visibleTokens.length; i += WARM_BATCH) {
        await Promise.all(visibleTokens.slice(i, i + WARM_BATCH).map(warmBoth));
      }

      // Priority 2: top-N last names by order frequency (excludes already-warmed)
      const rows = await query<{ token: string }>(
        `SELECT lower(customerLastName) AS token FROM orders
         GROUP BY customerLastName ORDER BY count() DESC LIMIT ${WARM_TOKENS}`,
      );
      const broader = rows.map(r => r.token).filter(Boolean).filter(t => !visibleSet.has(t));
      for (let i = 0; i < broader.length; i += WARM_BATCH) {
        await Promise.all(broader.slice(i, i + WARM_BATCH).map(warmBoth));
      }
    } catch {}
  };

  // Baseline warm at startup, then every 4 min
  void ping();
  setInterval(ping, 4 * 60 * 1000);

  // Token warm at startup (server-side, before any browser request lands)
  // then every 4 min so caches stay hot between intervals
  void warmTopTokens();
  setInterval(warmTopTokens, 4 * 60 * 1000);
}
