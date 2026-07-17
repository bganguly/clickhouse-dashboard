import { NextRequest, NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

async function raw(sql: string, params?: Record<string, unknown>): Promise<unknown> {
  try {
    const rs = await ch.query({ query: sql, format: "JSONEachRow", query_params: params });
    return await rs.json();
  } catch (e) {
    return { error: String(e) };
  }
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "will";
  const qLower = q.toLowerCase();

  const [
    sample,
    posCount,
    hasTokenCount,
    hasAllTokensInline,
    hasAllTokensParam,
    nameCount,
    nameSample,
  ] = await Promise.all([
    raw("SELECT searchText FROM orders LIMIT 2"),
    raw("SELECT count() AS n FROM orders WHERE positionCaseInsensitive(searchText, {q:String})", { q }),
    raw("SELECT count() AS n FROM orders WHERE hasToken(lower(searchText), {q:String})", { q: qLower }),
    raw(`SELECT count() AS n FROM orders WHERE hasAllTokens(lower(searchText), ['${qLower}'])`),
    raw("SELECT count() AS n FROM orders WHERE hasAllTokens(lower(searchText), {tokens:Array(String)})", { tokens: [qLower] }),
    raw("SELECT count() AS n FROM orders WHERE positionCaseInsensitive(customerFirstName, {q:String}) > 0 OR positionCaseInsensitive(customerLastName, {q:String}) > 0", { q }),
    raw("SELECT customerFirstName, customerLastName, searchText FROM orders WHERE positionCaseInsensitive(customerFirstName, {q:String}) > 0 OR positionCaseInsensitive(customerLastName, {q:String}) > 0 LIMIT 1", { q }),
  ]);

  return NextResponse.json({
    q,
    qLower,
    sample,
    positionCaseInsensitive_count: posCount,
    hasToken_lower_count: hasTokenCount,
    hasAllTokens_inline_array_count: hasAllTokensInline,
    hasAllTokens_param_array_count: hasAllTokensParam,
    name_contains_q_count: nameCount,
    name_sample_with_searchText: nameSample,
  });
}
