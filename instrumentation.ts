export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { query } = await import("@/lib/clickhouse");

  const ping = async () => {
    try {
      await query("SELECT 1");
    } catch {
      // best-effort keep-alive; swallow errors silently
    }
  };

  setInterval(ping, 20 * 60 * 1000);
}
