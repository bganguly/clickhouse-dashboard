import { query } from "@/lib/clickhouse";
import { AppError, mapDbError } from "@/lib/errors";
import { escapeLike } from "@/lib/services/orders.service";
import type { SearchInput, SearchResult, SearchResultItem } from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function search(input: SearchInput): Promise<SearchResult> {
  const q = input.q?.trim();
  if (!q) throw new AppError("BAD_REQUEST", "q (search query) is required");
  const qLower = q.toLowerCase();

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const [rawOrderRows, productRows, customerRows] = await Promise.all([
      (!input.entityType || input.entityType === "order")
        ? query<{ orderId: string; searchText: string }>(
            `SELECT orderId, searchText FROM orders
             WHERE hasToken(lower(searchText), {q: String})
             ORDER BY placedAt DESC LIMIT {lim: UInt32}`,
            { q: qLower, lim: limit },
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

    const orderRows =
      rawOrderRows.length === 0 && (!input.entityType || input.entityType === "order")
        ? await query<{ orderId: string; searchText: string }>(
            `SELECT orderId, searchText FROM orders
             WHERE lower(searchText) LIKE {q: String}
             ORDER BY placedAt DESC LIMIT {lim: UInt32}`,
            { q: `%${escapeLike(qLower)}%`, lim: limit },
          )
        : rawOrderRows;

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
