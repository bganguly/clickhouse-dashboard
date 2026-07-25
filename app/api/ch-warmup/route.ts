import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

let _warmed = false;

async function warmCaches() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { listOrders } = await import("@/lib/services/orders.service");
    const { getDailyAggregates } = await import("@/lib/services/aggregates.service");
    await Promise.all([
      listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" }),
      getDailyAggregates({ from: "2020-01-01", to: today, q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 5 }),
    ]);
  } catch {}
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
