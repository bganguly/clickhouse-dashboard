import { NextResponse } from "next/server";
import { DATASET_START, DATASET_END } from "@/lib/services/aggregates.service";

export async function GET() {
  return NextResponse.json({ from: DATASET_START, to: DATASET_END }, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
