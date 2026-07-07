import { NextRequest, NextResponse } from "next/server";
import {
  buildCountCacheKey,
  buildFilterConditions,
  buildSearchTextConditions,
  cachedCount,
  exactCount,
  isPureDateRangeQuery,
  resolveFilters,
  sumDailyOrderCount,
  whereClause,
} from "@/lib/services";

// GET /api/orders/count?q=&status=&regionCode=&from=&to=&minTotal=&maxTotal=
// Refinement endpoint fired by the frontend after a /api/orders response comes
// back `approximate: true` (see cappedCount in orders.service.ts). Always runs
// an uncapped exact count and writes it to count_cache, so this is also what
// makes a later cappedCount call for the same filter signature a cache hit.
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

  const conds = [...buildSearchTextConditions(q), ...buildFilterConditions(filters)];
  const whereSql = whereClause(conds);
  const cacheKey = buildCountCacheKey(q, filters);

  const total = isPureDateRangeQuery(q, filters)
    ? await sumDailyOrderCount(filters.from, filters.to)
    : await cachedCount(cacheKey, () => exactCount(whereSql));

  return NextResponse.json({ total });
}
