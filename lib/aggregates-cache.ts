import { redis } from "./redis";

const PREFIX = "agg:";
const MAX_ENTRIES = 500;

const store = new Map<string, { value: unknown }>();

function storeSet(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value });
}

export async function aggCacheGet<T>(key: string, _src?: { value: string }): Promise<T | null> {
  const entry = store.get(key);
  if (entry) {
    if (_src) _src.value = "mem";
    return entry.value as T;
  }
  if (redis) {
    try {
      const raw = await redis.get(PREFIX + key);
      if (raw) {
        const value = JSON.parse(raw) as T;
        storeSet(key, value);
        if (_src) _src.value = "redis";
        return value;
      }
    } catch {}
    return null;
  }
  return null;
}

export async function aggCacheSet(key: string, value: unknown): Promise<void> {
  storeSet(key, value);
  if (redis) {
    try { await redis.set(PREFIX + key, JSON.stringify(value)); } catch {}
  }
}

export async function invalidateAggregatesCache(): Promise<void> {
  store.clear();
  if (!redis) return;
  try {
    const keys = await redis.keys(PREFIX + "*");
    if (keys.length) await redis.del(...keys);
  } catch {}
}
