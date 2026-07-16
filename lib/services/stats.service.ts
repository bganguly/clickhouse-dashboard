import { query } from "@/lib/clickhouse";
import { mapDbError } from "@/lib/errors";

export interface SeedStats {
  customers: number;
  products: number;
}

export async function getSeedStats(): Promise<SeedStats> {
  try {
    const [cRows, pRows] = await Promise.all([
      query<{ n: string }>(`SELECT count() AS n FROM customers`),
      query<{ n: string }>(`SELECT count() AS n FROM products`),
    ]);
    return {
      customers: Number(cRows[0]?.n ?? 0),
      products: Number(pRows[0]?.n ?? 0),
    };
  } catch (err) {
    mapDbError(err, "getSeedStats");
  }
}
