import { createClient, type ClickHouseClient } from "@clickhouse/client";

const globalForCh = globalThis as unknown as { ch: ClickHouseClient };

export const ch: ClickHouseClient =
  globalForCh.ch ??
  createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: "default",
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
    },
  });

if (process.env.NODE_ENV !== "production") globalForCh.ch = ch;

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const rs = await ch.query({ query: sql, format: "JSONEachRow", query_params: params });
  return rs.json<T>();
}

export async function execute(sql: string, params?: Record<string, unknown>): Promise<void> {
  await ch.exec({ query: sql, query_params: params });
}

export async function insert<T extends Record<string, unknown>>(
  table: string,
  values: T[],
): Promise<void> {
  if (values.length === 0) return;
  await ch.insert({ table, values, format: "JSONEachRow" });
}
