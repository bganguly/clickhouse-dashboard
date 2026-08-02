import { NextRequest, NextResponse } from "next/server";
import { COUNT_SENTINEL, getDailyAggregates, getExactAggregateTotal, isAppError } from "@/lib/services";
import { diag } from "@/lib/diag";

// GET /api/aggregates?from=YYYY-MM-DD&to=YYYY-MM-DD&topCategories=<N>
//   filters (same as /api/orders): &status=&regionCode=&minTotal=&maxTotal=
//   (status/regionCode accept comma lists; from/to are the date range)
export async function GET(req: NextRequest) {
  const _routeT0 = Date.now();
  const { searchParams } = req.nextUrl;
  const _q = (searchParams.get("q") ?? "").trim() || "(none)";
  if (diag) console.log(`[api/aggregates] received q="${_q}"`);
  const topCategories = searchParams.get("topCategories");
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : null;
  };

  try {
    const query = {
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      q: (searchParams.get("q") ?? "").trim() || null,
      status: searchParams.get("status"),
      regionCode: searchParams.get("regionCode"),
      minTotal: num("minTotal"),
      maxTotal: num("maxTotal"),
      topCategories: topCategories ? Number(topCategories) : null,
    };
    // totalOrders is the exact distinct order count for this same range/filters
    // (same cached-count path /api/orders uses) — the per-category rows in
    // `data` can't be summed for a grand total since an order spanning
    // multiple categories gets counted once per category.
    const _diagSeries = { src: "?" };
    const _diagTotal = { src: "?" };
    const [data, totalOrders] = await Promise.all([
      getDailyAggregates(query, _diagSeries),
      getExactAggregateTotal(query, _diagTotal),
    ]);
    const _aggSrc = _diagSeries.src === "redis" && _diagTotal.src === "redis" ? "redis" : "ch";
    const approximate = totalOrders === COUNT_SENTINEL;
    if (diag) console.log(`[api/aggregates] total=${Date.now() - _routeT0}ms q="${_q}" src=${_aggSrc}`);
    return NextResponse.json({
      data,
      totalOrders: approximate ? 10_000 : totalOrders,
      ...(approximate ? { totalOrdersApproximate: true } : {}),
    }, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "X-Cache-Source": _aggSrc,
      },
    });
  } catch (err) {
    if (diag) console.log(`[api/aggregates] error total=${Date.now() - _routeT0}ms q="${_q}"`);
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
