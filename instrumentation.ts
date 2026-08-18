export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.CLICKHOUSE_URL) return;

  const { ensureCollection } = await import("@/lib/typesense");
  const { redis } = await import("@/lib/redis");

  await Promise.allSettled([
    ensureCollection(),
    redis?.ping(),
  ]);
}
