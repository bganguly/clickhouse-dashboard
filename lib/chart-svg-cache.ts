import { redis } from "@/lib/redis";

const PREFIX = "svg:chart:";
const STATUS_KEY = "svg:chart:_status";
const TTL_S = 86400;

const mem = new Map<string, string>();

export async function setChartSvg(q: string, svg: string): Promise<void> {
  mem.set(q, svg);
  if (redis) await redis.setex(PREFIX + q, TTL_S, svg).catch(() => {});
}

export async function getChartSvg(q: string): Promise<string | null> {
  const hit = mem.get(q);
  if (hit !== undefined) return hit;
  if (!redis) return null;
  const val = await redis.get(PREFIX + q).catch(() => null);
  if (val) mem.set(q, val);
  return val;
}

export async function setChartSvgStatus(ready: number, total: number): Promise<void> {
  if (redis) await redis.setex(STATUS_KEY, TTL_S, JSON.stringify({ ready, total })).catch(() => {});
}

export async function getChartSvgStatus(): Promise<{ ready: number; total: number } | null> {
  if (!redis) return null;
  const val = await redis.get(STATUS_KEY).catch(() => null);
  if (!val) return null;
  try { return JSON.parse(val) as { ready: number; total: number }; }
  catch { return null; }
}
