import { NextResponse } from "next/server";
import { getActiveStreamConnectionCount } from "@/lib/services";

// GET /api/stream/status — lets other apps (e.g. the quick-order companion)
// tell whether any dashboard tab currently has the "Live" checkbox on, i.e.
// whether a write will actually reload anywhere without a manual refresh.
export async function GET() {
  const count = getActiveStreamConnectionCount();
  return NextResponse.json({ connected: count > 0, count });
}
