export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { listOrders } = await import("@/lib/services/orders.service");

  const ping = async () => {
    try {
      await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" });
    } catch {
      // best-effort keep-alive; swallow errors silently
    }
  };

  setInterval(ping, 4 * 60 * 1000);
}
