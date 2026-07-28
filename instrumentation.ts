const WARM_TOKENS    = 100;
const WARM_BATCH     = 5;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { ensureCollection } = await import("@/lib/typesense");
  await ensureCollection().catch(() => {});

  const { listOrders } = await import("@/lib/services/orders.service");
  const { getDailyAggregates, getExactAggregateTotal } = await import("@/lib/services/aggregates.service");
  const { query } = await import("@/lib/clickhouse");

  const today = () => new Date().toISOString().slice(0, 10);

  const baseAggInput = () => ({
    from: "2020-01-01", to: today(), q: null as string | null,
    status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4,
  });

  const ping = async () => {
    try {
      await Promise.all([
        listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
        getDailyAggregates(baseAggInput()),
        getExactAggregateTotal(baseAggInput()),
      ]);
    } catch {}
  };

  const warmTopTokens = async () => {
    try {
      // Phase 1: listOrders cache — visible first-page tokens
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
        await Promise.all(visibleTokens.slice(i, i + WARM_BATCH).map(t =>
          listOrders({ q: t, page: 1, pageSize: 10, sort: "placedAt", dir: "desc" })
        ));
      }

      // Phase 2: listOrders cache — top-N last names
      const nameRows = await query<{ token: string }>(
        `SELECT lower(customerLastName) AS token FROM orders
         GROUP BY customerLastName ORDER BY count() DESC LIMIT ${WARM_TOKENS}`,
      );
      const broader = nameRows.map(r => r.token).filter(Boolean).filter(t => !visibleSet.has(t));
      for (let i = 0; i < broader.length; i += WARM_BATCH) {
        await Promise.all(broader.slice(i, i + WARM_BATCH).map(t =>
          listOrders({ q: t, page: 1, pageSize: 10, sort: "placedAt", dir: "desc" })
        ));
      }

    } catch {}
  };

  void ping();
  setInterval(ping, 4 * 60 * 1000);

  void warmTopTokens();
  setInterval(warmTopTokens, 4 * 60 * 1000);
}
