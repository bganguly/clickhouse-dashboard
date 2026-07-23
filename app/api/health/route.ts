import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export async function GET() {
  await query("SELECT count() FROM orders");
  return NextResponse.json({ status: "ok" });
}
