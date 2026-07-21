import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

export async function GET() {
  if (!process.env.CLICKHOUSE_URL) {
    return NextResponse.json({ status: "noop" }, { headers: CORS });
  }
  try {
    await query("SELECT 1");
    return NextResponse.json({ status: "ready" }, { headers: CORS });
  } catch {
    return NextResponse.json({ status: "warming" }, { status: 503, headers: CORS });
  }
}
