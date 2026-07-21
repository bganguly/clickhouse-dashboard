import { redis } from "./redis";

const PREFIX = "agg:";
const TTL_S = 10 * 60;
const MAX_ENTRIES = 50;

const store = new Map<string, { value: unknown; ts: number }>();

export async function aggCacheGet<T>(key: string): Promise<T | null> {
  if (redis) {
    try {
      const raw = await redis.get(PREFIX + key);
      if (raw) return JSON.parse(raw) as T;
    } catch {}
    return null;
  }
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_S * 1000) { store.delete(key); return null; }
  return entry.value as T;
}

export async function aggCacheSet(key: string, value: unknown): Promise<void> {
  if (redis) {
    try { await redis.setex(PREFIX + key, TTL_S, JSON.stringify(value)); } catch {}
    return;
  }
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, ts: Date.now() });
}

export async function invalidateAggregatesCache(): Promise<void> {
  store.clear();
  if (!redis) return;
  try {
    const keys = await redis.keys(PREFIX + "*");
    if (keys.length) await redis.del(...keys);
  } catch {}
}
