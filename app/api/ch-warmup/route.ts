import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { redis } from "@/lib/redis";

const WARM_SENTINEL = "warmup:done";
const WARM_SENTINEL_TTL = 60 * 60;

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

let _warmed   = false;
let _warming  = false;

const WARM_TOKENS   = 100;
const WARM_BATCH    = 10;

async function warmCaches() {
  if (_warming) return;
  _warming = true;
  try {
    const { listOrders } = await import("@/lib/services/orders.service");
    const { listCustomers } = await import("@/lib/services/customers.service");
    await listCustomers({ limit: 20 });

    const firstPage = await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" });

    const { getDailyAggregates, getExactAggregateTotal } = await import("@/lib/services/aggregates.service");
    const today = new Date().toISOString().slice(0, 10);
    const baseAgg = { from: "2024-07-17", to: today, q: null as string | null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4 };

    const warmBoth = (tok: string) => Promise.all([
      listOrders({ q: tok, page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
      getDailyAggregates({ ...baseAgg, q: tok }),
      getExactAggregateTotal({ ...baseAgg, q: tok }),
    ]);

    // Priority 1: every full word visible on the default first page (name + notes)
    const visibleSet = new Set<string>();
    for (const row of firstPage?.data ?? []) {
      const text = [row.customer.firstName, row.customer.lastName, row.notes ?? ""].join(" ");
      for (const w of text.split(/[^a-zA-Z]+/)) {
        const t = w.toLowerCase();
        if (t.length >= 3) visibleSet.add(t);
      }
    }
    const visibleTokens = [...visibleSet];
    for (let i = 0; i < visibleTokens.length; i += WARM_BATCH) {
      await Promise.all(visibleTokens.slice(i, i + WARM_BATCH).map(warmBoth));
    }

    // Priority 2: top-N last names by order frequency (excludes already-warmed)
    const tokenRows = await query<{ token: string }>(
      `SELECT lower(customerLastName) AS token FROM orders
       GROUP BY customerLastName ORDER BY count() DESC LIMIT ${WARM_TOKENS}`,
    );
    const broader = tokenRows.map(r => r.token).filter(Boolean).filter(t => !visibleSet.has(t));
    for (let i = 0; i < broader.length; i += WARM_BATCH) {
      await Promise.all(broader.slice(i, i + WARM_BATCH).map(warmBoth));
    }
    if (redis) await redis.setex(WARM_SENTINEL, WARM_SENTINEL_TTL, "1").catch(() => {});
  } catch {}
  _warming = false;
}

export async function GET() {
  if (!process.env.CLICKHOUSE_URL) {
    return NextResponse.json({ status: "noop" }, { headers: CORS });
  }
  try {
    await query("SELECT 1");
    if (!_warmed) {
      _warmed = true;
      void warmCaches();
    }
    const cacheReady = redis
      ? await redis.exists(WARM_SENTINEL).then(n => n === 1).catch(() => false)
      : true;
    return NextResponse.json({ status: "ready", cacheReady }, { headers: CORS });
  } catch {
    _warmed = false;
    return NextResponse.json({ status: "warming" }, { status: 503, headers: CORS });
  }
}
