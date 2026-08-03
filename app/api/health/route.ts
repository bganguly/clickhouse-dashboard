import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export async function GET() {
  try {
    await ch.query({ query: "SELECT 1" });
  } catch {
    // keep App Runner healthy even if ClickHouse is resuming from pause
  }
  return NextResponse.json({ status: "ok" });
}
