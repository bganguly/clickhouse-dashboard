import { NextResponse } from "next/server";
import { DATASET_START, getDatasetMaxDate } from "@/lib/services/aggregates.service";

export async function GET() {
  const to = await getDatasetMaxDate();
  return NextResponse.json({ from: DATASET_START, to }, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
