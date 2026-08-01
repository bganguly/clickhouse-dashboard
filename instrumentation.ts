const WARM_BATCH = 5;
const CH_READY_TIMEOUT_MS = 3 * 60 * 1000;
const CH_KEEPALIVE_MS = 8 * 60 * 1000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { query } = await import("@/lib/clickhouse");
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

  const waitForClickHouse = async (): Promise<boolean> => {
    const deadline = Date.now() + CH_READY_TIMEOUT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      try {
        const t0 = Date.now();
        await query("SELECT 1");
        const ms = Date.now() - t0;
        if (ms < 2000) {
          console.log(`[warmup] ClickHouse ready (${ms}ms, attempt ${attempt + 1})`);
          return true;
        }
        console.log(`[warmup] ClickHouse still cold (${ms}ms, attempt ${attempt + 1}) — retrying`);
      } catch {
        console.log(`[warmup] ClickHouse not reachable (attempt ${attempt + 1}) — retrying`);
      }
      attempt++;
      await new Promise(r => setTimeout(r, 10_000));
    }
    console.log("[warmup] ClickHouse did not become ready within timeout — skipping warmup");
    return false;
  };

  const warmVisibleTokens = async () => {
    try {
      const ready = await waitForClickHouse();
      if (!ready) return;

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

  void warmVisibleTokens();

  setInterval(() => {
    query("SELECT 1").catch(() => {});
  }, CH_KEEPALIVE_MS);
}
