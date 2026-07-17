const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 200;

interface CacheEntry { value: unknown; ts: number; }
const store = new Map<string, CacheEntry>();

export function searchCacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { store.delete(key); return null; }
  return entry.value as T;
}

export function searchCacheSet(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, ts: Date.now() });
}

export function invalidateSearchCache(): void {
  store.clear();
}
