import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

let _warmed   = false;
let _warming  = false;

const WARM_TOKENS   = 100;
const WARM_BATCH    = 10;
const REWARM_MS     = 4 * 60 * 1000;

async function warmCaches() {
  if (_warming) return;
  _warming = true;
  try {
    const { listOrders } = await import("@/lib/services/orders.service");

    const firstPage = await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" });

    const warmBoth = (tok: string) =>
      listOrders({ q: tok, page: 1, pageSize: 10, sort: "placedAt", dir: "desc" });

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
  } catch {}
  _warming = false;
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
