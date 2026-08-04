import { NextRequest, NextResponse } from "next/server";
import { getChartSvg, getChartSvgStatus } from "@/lib/chart-svg-cache";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  if (searchParams.get("status") === "1") {
    const status = await getChartSvgStatus();
    return NextResponse.json(status ?? { ready: 0, total: 100 });
  }

  const q = (searchParams.get("q") ?? "").trim();
  const svg = await getChartSvg(q);
  if (!svg) return new NextResponse(null, { status: 404 });

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
