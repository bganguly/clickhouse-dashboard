import { query, insert } from "@/lib/clickhouse";
import { AppError, mapDbError } from "@/lib/errors";
import { invalidateAggregatesCache } from "@/lib/aggregates-cache";
import { searchCacheGet, searchCacheSet, invalidateSearchCache } from "@/lib/search-cache";
import { publishOrderEvent } from "./stream.service";
import type {
  CreateOrderInput,
  CreateOrderResult,
  FacetCount,
  OrderDTO,
  OrderFacets,
  OrderFilterInput,
  OrderItemDTO,
  OrderListInput,
  OrderListResult,
  OrderSortField,
  OrderStatus,
  SortDir,
} from "@/lib/types";

const SEARCH_CACHE = {
  use_query_cache: 1 as const,
  query_cache_ttl: 300,
  query_cache_share_between_users: 1 as const,
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT: OrderSortField = "placedAt";
const DEFAULT_DIR: SortDir = "desc";
export const COUNT_SENTINEL = 10_001;

const ORDER_STATUSES: readonly OrderStatus[] = [
  "PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED",
];

const SORT_COL: Record<OrderSortField, string> = {
  placedAt: "placedAt",
  total: "total",
  status: "status",
  customer: "customerLastName",
  id: "orderId",
};

function normalizeSort(sort: string | null | undefined): OrderSortField {
  return sort != null && sort in SORT_COL ? (sort as OrderSortField) : DEFAULT_SORT;
}

function normalizeDir(dir: string | null | undefined): SortDir {
  return dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;
}

const NOTES_POOL = [
  "please leave at front door ring bell twice",
  "gift wrapping requested include birthday card",
  "fragile items handle with extreme care",
  "corporate bulk order for quarterly offsite event",
  "express shipping required before the conference",
  "leave with building concierge if not home",
  "signature required upon delivery no exceptions",
  "urgent replacement for previously damaged shipment",
  "perishable contents keep refrigerated at all times",
  "eco friendly packaging only no plastic wrap",
  "annual office supply subscription renewal invoice",
  "school supply order for upcoming fall semester",
  "bridal shower gift please include congratulations card",
  "rush order needed before saturday morning delivery",
  "holiday promotional bundle seasonal discount applied",
  "wholesale distributor recurring weekly standing order",
  "loyalty rewards redemption free shipping included",
  "priority processing customer complaint credit applied",
  "temperature sensitive store below forty degrees fahrenheit",
  "military veteran discount applied thank you for service",
] as const;

function pickNote(): string {
  return NOTES_POOL[Math.floor(Math.random() * NOTES_POOL.length)];
}

export function escapeLike(input: string): string {
  return input.replace(/'/g, "''");
}

export function normalizeStatusList(csv: string | null | undefined): OrderStatus[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(s));
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ResolvedFilters {
  statuses: OrderStatus[];
  regionCodes: string[];
  from: string | null;
  to: string | null;
  minTotal: number | null;
  maxTotal: number | null;
  hasAny: boolean;
}

function parseList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseDateBoundary(value: string | null | undefined, edge: "start" | "end"): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError("BAD_REQUEST", `invalid date filter: ${value}`);
  if (edge === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    d.setUTCHours(23, 59, 59, 999);
    return d.toISOString().replace("T", " ").replace("Z", "");
  }
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export async function resolveFilters(input: OrderFilterInput): Promise<ResolvedFilters> {
  const statuses = normalizeStatusList(input.status);
  const regionCodes = parseList(input.regionCode);
  const from = parseDateBoundary(input.from, "start");
  const toRaw = input.to || (input.from ? todayDateString() : input.to);
  const to = parseDateBoundary(toRaw, "end");
  const minTotal = input.minTotal ?? null;
  const maxTotal = input.maxTotal ?? null;
  const hasAny =
    statuses.length > 0 || regionCodes.length > 0 || from !== null || to !== null ||
    minTotal !== null || maxTotal !== null;
  return { statuses, regionCodes, from, to, minTotal, maxTotal, hasAny };
}

function buildWhereParts(
  searchTokens: string[],
  f: ResolvedFilters,
): { clauses: string[]; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  let pi = 0;
  for (const tok of searchTokens) {
    const k = `stok${pi++}`;
    clauses.push(`hasToken(searchText, {${k}: String})`);
    params[k] = tok.toLowerCase();
  }
  if (f.statuses.length) {
    clauses.push(`status IN ({statuses: Array(String)})`);
    params["statuses"] = f.statuses;
  }
  if (f.regionCodes.length) {
    clauses.push(`regionCode IN ({regionCodes: Array(String)})`);
    params["regionCodes"] = f.regionCodes;
  }
  if (f.from) {
    clauses.push(`placedAt >= {from: DateTime64(3)}`);
    params["from"] = f.from;
  }
  if (f.to) {
    clauses.push(`placedAt <= {to: DateTime64(3)}`);
    params["to"] = f.to;
  }
  if (f.minTotal !== null) {
    clauses.push(`total >= {minTotal: Float64}`);
    params["minTotal"] = f.minTotal;
  }
  if (f.maxTotal !== null) {
    clauses.push(`total <= {maxTotal: Float64}`);
    params["maxTotal"] = f.maxTotal;
  }
  return { clauses, params };
}

function whereSQL(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

type OrderRow = {
  orderId: string; status: string; total: string; currency: string; notes: string | null;
  placedAt: string; customerId: string; regionId: string; regionCode: string;
  customerFirstName: string; customerLastName: string; customerEmail: string;
  itemCount: string;
};

function rowToDTO(r: OrderRow): OrderDTO {
  return {
    id: Number(r.orderId),
    status: r.status as OrderStatus,
    total: Number(r.total),
    currency: r.currency,
    notes: r.notes,
    placedAt: new Date(r.placedAt).toISOString(),
    customer: {
      id: Number(r.customerId),
      email: r.customerEmail,
      firstName: r.customerFirstName,
      lastName: r.customerLastName,
    },
    region: { id: Number(r.regionId), code: r.regionCode, name: r.regionCode },
    items: new Array(Number(r.itemCount)) as unknown as OrderItemDTO[],
  };
}

const ORDER_SELECT = `SELECT orderId, status, total, currency, notes, placedAt,
  customerId, regionId, regionCode,
  customerFirstName, customerLastName, customerEmail, itemCount
FROM orders`;

export async function listOrders(input: OrderListInput): Promise<OrderListResult> {
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const sort = normalizeSort(input.sort);
  const dir = normalizeDir(input.dir);
  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);
  const offset = (page - 1) * pageSize;

  const cacheKey = `rows:${JSON.stringify({ q: input.q, page, pageSize, sort, dir, status: input.status, regionCode: input.regionCode, from: input.from, to: input.to, minTotal: input.minTotal, maxTotal: input.maxTotal })}`;
  const cached = await searchCacheGet<OrderListResult>(cacheKey);
  if (cached) return cached;

  try {
    const t0 = Date.now();
    const filters = await resolveFilters(input);
    const { clauses, params } = buildWhereParts(tokens, filters);
    const where = whereSQL(clauses);
    const sortCol = SORT_COL[sort];
    const orderBy = `${sortCol} ${dir.toUpperCase()}, orderId ${dir.toUpperCase()}`;

    const orderRows = await query<OrderRow>(
      `${ORDER_SELECT} ${where} ORDER BY ${orderBy} LIMIT {lim: UInt32} OFFSET {off: UInt32}`,
      { ...params, lim: pageSize, off: offset },
      SEARCH_CACHE,
    );
    console.log(`[orders] listOrders ms=${Date.now() - t0} from=${input.from ?? ""} to=${input.to ?? ""} q=${input.q ?? ""} sort=${sort} dir=${dir} page=${page}`);

    const data = orderRows.map(rowToDTO);
    const result: OrderListResult = { data, page, pageSize, total: 0, totalPages: 0, approximate: false, countPending: true };
    if (input.facets) result.facets = await computeFacets(where, params);
    await searchCacheSet(cacheKey, result);
    return result;
  } catch (err) {
    mapDbError(err, "listOrders");
  }
}

export async function listOrdersByCursor(
  input: OrderListInput & { cursorId: number; cursorPlacedAt: string; cursorDir: "next" | "prev" },
): Promise<OrderListResult> {
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);

  try {
    const filters = await resolveFilters(input);
    const { clauses: baseClauses, params: baseParams } = buildWhereParts(tokens, filters);

    const cursorTs = new Date(input.cursorPlacedAt)
      .toISOString().replace("T", " ").replace("Z", "");
    const isNext = input.cursorDir === "next";
    const cursorClause = isNext
      ? `(placedAt, orderId) < ({cTs: DateTime64(3)}, {cId: UInt64})`
      : `(placedAt, orderId) > ({cTs: DateTime64(3)}, {cId: UInt64})`;
    const allClauses = [...baseClauses, cursorClause];
    const allParams = { ...baseParams, cTs: cursorTs, cId: input.cursorId };
    const where = whereSQL(allClauses);
    const dirSQL = isNext ? "DESC" : "ASC";

    const pageRows = await query<OrderRow>(
      `${ORDER_SELECT} ${where} ORDER BY placedAt ${dirSQL}, orderId ${dirSQL} LIMIT {lim: UInt32}`,
      { ...allParams, lim: pageSize },
      SEARCH_CACHE,
    );

    const data = (isNext ? pageRows : pageRows.reverse()).map(rowToDTO);
    const result: OrderListResult = { data, page, pageSize, total: 0, totalPages: 0, approximate: false, countPending: true };
    if (input.facets) result.facets = await computeFacets(whereSQL(baseClauses), baseParams);
    return result;
  } catch (err) {
    mapDbError(err, "listOrdersByCursor");
  }
}


async function computeFacets(
  where: string,
  params: Record<string, unknown>,
): Promise<OrderFacets> {
  const rows = await query<{ dim: string; key: string; n: string }>(
    `SELECT 'status' AS dim, status AS key, count() AS n FROM orders ${where} GROUP BY status
     UNION ALL
     SELECT 'region' AS dim, regionCode AS key, count() AS n FROM orders ${where} GROUP BY regionCode`,
    params,
    SEARCH_CACHE,
  );

  const status: FacetCount[] = [];
  const region: FacetCount[] = [];
  for (const r of rows) {
    const fc: FacetCount = { value: r.key, count: Number(r.n) };
    if (r.dim === "status") status.push(fc);
    else region.push(fc);
  }
  status.sort((a, b) => b.count - a.count);
  region.sort((a, b) => b.count - a.count);
  return { status, region, approximate: false };
}

let _nextId = Date.now();
function genId(): number {
  return ++_nextId;
}

function prefixTokens(word: string, minLen = 3): string {
  if (word.length < minLen) return "";
  const out: string[] = [];
  for (let i = minLen; i <= word.length; i++) {
    out.push(word.slice(0, i).toLowerCase());
  }
  return out.join(" ");
}

function buildSearchText(
  firstName: string,
  lastName: string,
  orderId: number,
  notes?: string | null,
): string {
  const parts = [firstName.toLowerCase(), lastName.toLowerCase(), String(orderId)];
  if (notes) parts.push(notes);
  const prefs = [prefixTokens(firstName), prefixTokens(lastName)].filter(Boolean);
  if (prefs.length) parts.push(...prefs);
  return parts.join(" ");
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (!input.customerId || !input.regionId || !Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("BAD_REQUEST", "customerId, regionId, and at least one item are required");
  }
  for (const it of input.items) {
    if (!it.productId || it.quantity <= 0 || it.unitPrice < 0) {
      throw new AppError("BAD_REQUEST", "each item needs productId, positive quantity, non-negative unitPrice");
    }
  }

  const total = input.items.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice * (1 - (it.discount ?? 0)),
    0,
  );

  try {
    const [customerRows, productRows, regionRows] = await Promise.all([
      query<{ customerId: string; firstName: string; lastName: string; email: string; regionId: string }>(
        `SELECT customerId, firstName, lastName, email, regionId FROM customers WHERE customerId = {cid: UInt64} LIMIT 1`,
        { cid: input.customerId },
      ),
      query<{ productId: string; sku: string; name: string; categoryId: string; categoryName: string }>(
        `SELECT p.productId, p.sku, p.name, p.categoryId, c.name AS categoryName
         FROM products p JOIN categories c ON c.categoryId = p.categoryId
         WHERE p.productId IN (${input.items.map((i) => i.productId).join(",")})`,
      ),
      query<{ regionId: string; code: string; name: string }>(
        `SELECT regionId, code, name FROM regions WHERE regionId = {rid: UInt32} LIMIT 1`,
        { rid: input.regionId },
      ),
    ]);

    const customer = customerRows[0];
    if (!customer) throw new AppError("NOT_FOUND", `customer ${input.customerId} not found`);
    const region = regionRows[0];
    if (!region) throw new AppError("NOT_FOUND", `region ${input.regionId} not found`);

    const productById = new Map(productRows.map((p) => [Number(p.productId), p]));

    const orderId = genId();
    const placedAt = new Date().toISOString().replace("T", " ").replace("Z", "");
    const date = placedAt.slice(0, 10);
    const resolvedNotes = input.notes ?? pickNote();
    const searchText = buildSearchText(customer.firstName, customer.lastName, orderId, resolvedNotes);

    await insert("orders", [{
      orderId,
      customerId: input.customerId,
      regionId: input.regionId,
      regionCode: region.code,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
      customerEmail: customer.email,
      status: "PENDING",
      total,
      currency: input.currency ?? "USD",
      notes: resolvedNotes,
      searchText,
      placedAt,
      itemCount: input.items.length,
    }]);

    const itemRows = input.items.map((it) => {
      const p = productById.get(it.productId);
      return {
        itemId: genId(),
        orderId,
        productId: it.productId,
        productName: p?.name ?? "",
        productSku: p?.sku ?? "",
        categoryId: p ? Number(p.categoryId) : 0,
        categoryName: p?.categoryName ?? "",
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        discount: it.discount ?? 0,
      };
    });
    await insert("order_items", itemRows);

    const byCategory = new Map<number, { categoryId: number; categoryName: string; totalItems: number; totalRevenue: number }>();
    for (const it of itemRows) {
      const rev = it.quantity * it.unitPrice * (1 - it.discount);
      const entry = byCategory.get(it.categoryId);
      if (entry) {
        entry.totalItems += it.quantity;
        entry.totalRevenue += rev;
      } else {
        byCategory.set(it.categoryId, { categoryId: it.categoryId, categoryName: it.categoryName, totalItems: it.quantity, totalRevenue: rev });
      }
    }

    const factRows = Array.from(byCategory.values()).map((c) => ({
      orderId,
      date,
      placedAt,
      customerId: input.customerId,
      regionId: input.regionId,
      regionCode: region.code,
      status: "PENDING",
      orderTotal: total,
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      totalItems: c.totalItems,
      totalRevenue: c.totalRevenue,
      searchText,
    }));
    await insert("order_category_facts", factRows);

    const firstCategorySlug = itemRows[0]?.categoryName;
    publishOrderEvent({
      id: orderId,
      total,
      customerId: input.customerId,
      placedAt: new Date(placedAt).toISOString(),
      categorySlug: firstCategorySlug,
    }).catch(() => {});

    await Promise.all([invalidateAggregatesCache(), invalidateSearchCache()]);

    return { id: orderId, status: "PENDING", total, placedAt: new Date(placedAt).toISOString() };
  } catch (err) {
    mapDbError(err, "createOrder");
  }
}

export function isPureDateRangeQuery(q: string | undefined, filters: ResolvedFilters): boolean {
  return (
    !q?.trim() &&
    filters.statuses.length === 0 &&
    filters.regionCodes.length === 0 &&
    filters.minTotal === null &&
    filters.maxTotal === null
  );
}

void (process.env.CLICKHOUSE_URL && (async () => {
  try {
    await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc" });
  } catch {}
})());

export async function getOrderCount(
  q: string | undefined,
  filters: ResolvedFilters,
): Promise<number> {
  const cacheKey = `count:${JSON.stringify({ q, ...filters })}`;
  const cached = await searchCacheGet<number>(cacheKey);
  if (cached != null) return cached;

  const tokens = (q?.trim() ?? "").split(/\s+/).filter(Boolean);

  if (
    tokens.length === 1 &&
    !filters.statuses.length &&
    !filters.regionCodes.length &&
    filters.minTotal === null &&
    filters.maxTotal === null
  ) {
    const clauses = [`token = {tok: String}`];
    const params: Record<string, unknown> = { tok: tokens[0].toLowerCase() };
    if (filters.from) { clauses.push(`date >= {from: Date}`); params["from"] = filters.from.slice(0, 10); }
    if (filters.to)   { clauses.push(`date <= {to: Date}`);   params["to"]   = filters.to.slice(0, 10); }
    const summaryRows = await query<{ n: string }>(
      `SELECT sum(orderCount) AS n FROM daily_search_token_summary WHERE ${clauses.join(" AND ")}`,
      params,
      SEARCH_CACHE,
    );
    const fastTotal = Number(summaryRows[0]?.n ?? 0);
    if (fastTotal > 0) {
      await searchCacheSet(cacheKey, fastTotal);
      return fastTotal;
    }
  }

  const { clauses, params } = buildWhereParts(tokens, filters);
  const where = whereSQL(clauses);
  const rows = await query<{ n: string }>(
    `SELECT count() AS n FROM orders ${where}`,
    params,
    SEARCH_CACHE,
  );
  const total = Number(rows[0]?.n ?? 0);
  await searchCacheSet(cacheKey, total);
  return total;
}
