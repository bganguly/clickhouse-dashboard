import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export async function GET() {
  const t0 = Date.now();
  try {
    await query<{ one: string }>("SELECT 1 AS one");
    return NextResponse.json({ ok: true, ms: Date.now() - t0 }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ ok: false, ms: Date.now() - t0 }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
