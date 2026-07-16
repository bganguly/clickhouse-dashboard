import { query } from "@/lib/clickhouse";
import { AppError, mapDbError } from "@/lib/errors";
import type { SearchInput, SearchResult, SearchResultItem } from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function search(input: SearchInput): Promise<SearchResult> {
  const q = input.q?.trim();
  if (!q) throw new AppError("BAD_REQUEST", "q (search query) is required");

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const [orderRows, productRows, customerRows] = await Promise.all([
      (!input.entityType || input.entityType === "order")
        ? query<{ orderId: string; searchText: string }>(
            `SELECT orderId, searchText FROM orders
             WHERE positionCaseInsensitive(searchText, {q: String}) > 0
             ORDER BY placedAt DESC LIMIT {lim: UInt32}`,
            { q, lim: limit },
          )
        : Promise.resolve([]),
      (!input.entityType || input.entityType === "product")
        ? query<{ productId: string; name: string; sku: string }>(
            `SELECT productId, name, sku FROM products
             WHERE positionCaseInsensitive(name || ' ' || sku, {q: String}) > 0
             LIMIT {lim: UInt32}`,
            { q, lim: limit },
          )
        : Promise.resolve([]),
      (!input.entityType || input.entityType === "customer")
        ? query<{ customerId: string; firstName: string; lastName: string; email: string }>(
            `SELECT customerId, firstName, lastName, email FROM customers
             WHERE positionCaseInsensitive(firstName || ' ' || lastName || ' ' || email, {q: String}) > 0
             LIMIT {lim: UInt32}`,
            { q, lim: limit },
          )
        : Promise.resolve([]),
    ]);

    const results: SearchResultItem[] = [
      ...orderRows.map((r) => ({ entityType: "order", entityId: Number(r.orderId), content: r.searchText })),
      ...productRows.map((r) => ({ entityType: "product", entityId: Number(r.productId), content: `${r.name} ${r.sku}` })),
      ...customerRows.map((r) => ({ entityType: "customer", entityId: Number(r.customerId), content: `${r.firstName} ${r.lastName} ${r.email}` })),
    ].slice(0, limit);

    return { query: q, results };
  } catch (err) {
    mapDbError(err, "search");
  }
}
