import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export async function GET() {
  await (await ch.query({ query: "SELECT 1", format: "JSONEachRow" })).json();
  return NextResponse.json({ status: "ok" });
}
