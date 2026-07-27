import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import type { AggregateQueryInput } from "@/lib/types";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

let _warmed   = false;
let _warming  = false;

const WARM_TOKENS   = 20;
const WARM_BATCH    = 5;
const REWARM_MS     = 4 * 60 * 1000; // re-warm every 4 min (cache TTL is 5 min)

async function warmCaches() {
  if (_warming) return;
  _warming = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { listOrders } = await import("@/lib/services/orders.service");
    const { getDailyAggregates, getExactAggregateTotal } = await import("@/lib/services/aggregates.service");
    const aggInput: AggregateQueryInput = { from: "2020-01-01", to: today, q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4 };

    // Baseline: no-q page 1 + aggregates
    await Promise.all([
      listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
      getDailyAggregates(aggInput),
      getExactAggregateTotal(aggInput),
    ]);

    // Plan G: prime top-N search terms — dual-write (Plan C) also warms pageSize=20
    const tokenRows = await query<{ token: string }>(
      `SELECT token FROM daily_search_token_summary
       GROUP BY token ORDER BY sum(orderCount) DESC LIMIT ${WARM_TOKENS}`,
    );
    const tokens = tokenRows.map(r => r.token).filter(Boolean);
    for (let i = 0; i < tokens.length; i += WARM_BATCH) {
      await Promise.all(
        tokens.slice(i, i + WARM_BATCH).map(tok =>
          listOrders({ q: tok, page: 1, pageSize: 10, sort: "placedAt", dir: "desc", facets: true }),
        ),
      );
    }
  } catch {}
  _warming = false;
  // Schedule next cycle so the in-memory cache never goes cold on long-lived instances
  setTimeout(() => { void warmCaches(); }, REWARM_MS);
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
    return NextResponse.json({ status: "ready" }, { headers: CORS });
  } catch {
    _warmed = false;
    return NextResponse.json({ status: "warming" }, { status: 503, headers: CORS });
  }
}
