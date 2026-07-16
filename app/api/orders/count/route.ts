import { NextRequest, NextResponse } from "next/server";
import { getOrderCount, resolveFilters } from "@/lib/services";

// GET /api/orders/count — exact count for the same filters as /api/orders.
// Fired after an approximate response; ClickHouse makes this cheap without a cache.
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : undefined;
  };

  const q = searchParams.get("q")?.trim();
  const filters = await resolveFilters({
    status: searchParams.get("status"),
    regionCode: searchParams.get("regionCode"),
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    minTotal: num("minTotal") ?? null,
    maxTotal: num("maxTotal") ?? null,
  });

  const total = await getOrderCount(q, filters);
  return NextResponse.json({ total });
}
