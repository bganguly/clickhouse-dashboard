import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export async function GET() {
  await ch.ping();
  return NextResponse.json({ status: "ok" });
}
