import { NextRequest, NextResponse } from "next/server";
import { getDailyAggregates, getExactAggregateTotal, isAppError } from "@/lib/services";

// GET /api/aggregates?from=YYYY-MM-DD&to=YYYY-MM-DD&topCategories=<N>
//   filters (same as /api/orders): &status=&regionCode=&minTotal=&maxTotal=
//   (status/regionCode accept comma lists; from/to are the date range)
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const topCategories = searchParams.get("topCategories");
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : null;
  };

  try {
    const query = {
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      q: searchParams.get("q"),
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
    const [data, totalOrders] = await Promise.all([
      getDailyAggregates(query),
      getExactAggregateTotal(query),
    ]);
    return NextResponse.json({ data, totalOrders });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
