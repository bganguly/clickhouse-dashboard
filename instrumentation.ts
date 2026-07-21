export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { runMigrations } = await import("@/lib/schema");
  const { query } = await import("@/lib/clickhouse");

  // Run DDL migrations at startup so schema is always current.
  // All statements are IF NOT EXISTS / IF EXISTS — safe to re-run on every boot.
  runMigrations().catch((e) => console.error("[instrumentation] migration error:", e));

  const ping = async () => {
    try {
      await query("SELECT 1");
    } catch {
      // best-effort keep-alive; swallow errors silently
    }
  };

  setInterval(ping, 20 * 60 * 1000);
}
