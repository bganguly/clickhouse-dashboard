import { NextRequest, NextResponse } from "next/server";
import { isAppError, listCustomers } from "@/lib/services";

// GET /api/customers?q=&limit=&cursor=&regionId=
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : undefined;
  };

  try {
    const result = await listCustomers({
      q: searchParams.get("q"),
      limit: num("limit"),
      cursor: num("cursor") ?? null,
      regionId: num("regionId") ?? null,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=31536000, immutable" },
    });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
