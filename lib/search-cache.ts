import { redis } from "./redis";

const STACK = process.env.CACHE_STACK_PREFIX ?? "";
const PREFIX = STACK ? `${STACK}:search:` : "search:";
const TTL_S = 90 * 24 * 60 * 60;
const MAX_ENTRIES = 500;

const store = new Map<string, { value: unknown; ts: number }>();

function storeSet(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, ts: Date.now() });
}

export async function searchCacheGet<T>(key: string, _src?: { value: string }): Promise<T | null> {
  const entry = store.get(key);
  if (entry) {
    if (Date.now() - entry.ts > TTL_S * 1000) {
      store.delete(key);
    } else {
      if (_src) _src.value = "mem";
      return entry.value as T;
    }
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

export async function searchCacheSet(key: string, value: unknown): Promise<void> {
  storeSet(key, value);
  if (redis) {
    try { await redis.setex(PREFIX + key, TTL_S, JSON.stringify(value)); } catch {}
  }
}

export async function invalidateSearchCache(): Promise<void> {
  store.clear();
  if (!redis) return;
  try {
    const keys = await redis.keys(PREFIX + "*");
    if (keys.length) await redis.del(...keys);
  } catch {}
}
