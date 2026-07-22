import { type NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

interface VocabRow {
  token: string;
  doc_freq: string;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
  if (raw.length < 2) return NextResponse.json({ suggestions: [] });

  try {
    const rows = await query<VocabRow>(
      `SELECT token, doc_freq
       FROM search_vocabulary
       WHERE lower(token) LIKE {q: String}
       ORDER BY doc_freq DESC
       LIMIT 8`,
      { q: `%${raw}%` },
    );
    return NextResponse.json({
      suggestions: rows.map((r) => ({ token: r.token, freq: Number(r.doc_freq) })),
    });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
