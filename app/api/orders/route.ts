import { NextRequest, NextResponse } from "next/server";
import { createOrder, isAppError, listOrders, listOrdersByCursor } from "@/lib/services";
import type { CreateOrderInput } from "@/lib/types";

// GET /api/orders?q=&page=&pageSize=&sort=&dir=
//   filters: &status=&regionCode=&from=&to=&minTotal=&maxTotal=  (status/regionCode accept comma lists)
//   &facets=1 to include sidebar facet counts
//   &cursorId=&cursorPlacedAt=&cursorDir=next|prev — keyset Prev/Next, only
//   honored when sort=placedAt&dir=desc (the default); any other combination
//   is purely additive and falls back to the plain OFFSET path unchanged.
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : undefined;
  };

  const sort = searchParams.get("sort");
  const dir = searchParams.get("dir");
  const cursorId = num("cursorId");
  const cursorPlacedAt = searchParams.get("cursorPlacedAt");
  const cursorDirRaw = searchParams.get("cursorDir");
  const cursorDir = cursorDirRaw === "next" || cursorDirRaw === "prev" ? cursorDirRaw : undefined;

  const baseInput = {
    page: num("page"),
    pageSize: num("pageSize"),
    q: searchParams.get("q"),
    sort,
    dir,
    status: searchParams.get("status"),
    regionCode: searchParams.get("regionCode"),
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    minTotal: num("minTotal") ?? null,
    maxTotal: num("maxTotal") ?? null,
    facets: searchParams.get("facets") === "1" || searchParams.get("facets") === "true",
  };

  const useCursor =
    cursorId !== undefined &&
    !!cursorPlacedAt &&
    !!cursorDir &&
    (sort == null || sort === "placedAt") &&
    (dir == null || dir === "desc");

  try {
    const result = useCursor
      ? await listOrdersByCursor({
          ...baseInput,
          cursorId: cursorId!,
          cursorPlacedAt: cursorPlacedAt!,
          cursorDir: cursorDir!,
        })
      : await listOrders(baseInput);
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// POST /api/orders
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateOrderInput;
    const order = await createOrder(body);
    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function toErrorResponse(err: unknown) {
  if (isAppError(err)) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status: err.status },
    );
  }
  return NextResponse.json({ error: "internal server error" }, { status: 500 });
}
