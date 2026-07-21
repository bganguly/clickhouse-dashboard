import { NextResponse } from "next/server";
import { isAppError, listRegions } from "@/lib/services";

// GET /api/regions -> [{ code, name }, ...]  (full list for the region dropdown)
export async function GET() {
  try {
    const regions = await listRegions();
    return NextResponse.json(regions, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
