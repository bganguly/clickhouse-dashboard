import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export async function GET() {
  if (!process.env.CLICKHOUSE_URL) {
    return NextResponse.json({ status: "noop" });
  }
  try {
    await query("SELECT 1");
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "warming" }, { status: 503 });
  }
}
