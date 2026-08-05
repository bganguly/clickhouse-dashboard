import { query, insert } from "@/lib/clickhouse";
import { diag } from "@/lib/diag";
import { AppError, mapDbError } from "@/lib/errors";
import { invalidateAggregatesCache } from "@/lib/aggregates-cache";
import { searchCacheGet, searchCacheSet, invalidateSearchCache } from "@/lib/search-cache";
import { singleFlight } from "@/lib/single-flight";
import { publishOrderEvent } from "./stream.service";
import * as typesense from "@/lib/typesense";
import type {
  CreateOrderInput,
  CreateOrderResult,
  OrderDTO,
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

export async function listOrders(input: OrderListInput, _diag?: { src: string }): Promise<OrderListResult> {
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const sort = normalizeSort(input.sort);
  const dir = normalizeDir(input.dir);
  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);
  const offset = (page - 1) * pageSize;

  const cacheKey = `rows:${JSON.stringify({ q: input.q || null, page, pageSize, sort, dir, status: input.status || null, regionCode: input.regionCode || null, from: input.from || null, to: input.to || null, minTotal: input.minTotal ?? null, maxTotal: input.maxTotal ?? null })}`;
  if (diag && input.q) console.log(`[search-cache] received q="${input.q}"`);
  else if (diag) console.log(`[search-cache] received base-case (no q)`);
  const _cacheT0 = Date.now();
  const _hitSrc = { value: "ch" };
  const cached = await searchCacheGet<OrderListResult>(cacheKey, _hitSrc);
  const _cacheMs = Date.now() - _cacheT0;
  if (cached) {
    if (_diag) _diag.src = _hitSrc.value;
    if (diag && input.q) console.log(`[search-cache] q="${input.q}" → list view HIT src=${_hitSrc.value} ${_hitSrc.value !== "mem" ? `redis=${_cacheMs}ms` : ""}`);
    else if (diag) console.log(`[search-cache] base-case → list view HIT src=${_hitSrc.value} ${_hitSrc.value !== "mem" ? `redis=${_cacheMs}ms` : ""}`);
    return cached;
  }
  if (_diag) _diag.src = "ch";
  if (diag && input.q) console.log(`[search-cache] q="${input.q}" → list view MISS redis=${_cacheMs}ms`);
  else if (diag) console.log(`[search-cache] base-case → list view MISS redis=${_cacheMs}ms`);

  return singleFlight(cacheKey, async () => {
    try {
      const t0 = Date.now();
      const filters = await resolveFilters(input);

      const searchTokens = tokens.length > 0 && typesense.isEnabled()
        ? await Promise.all(tokens.map((t) => typesense.expandPrefix(t)))
        : tokens;

      const { clauses, params } = buildWhereParts(searchTokens, filters);
      const where = whereSQL(clauses);
      const sortCol = SORT_COL[sort];
      const orderBy = `${sortCol} ${dir.toUpperCase()}, orderId ${dir.toUpperCase()}`;

      // Over-fetch up to DEFAULT_PAGE_SIZE on page 1 so we can warm the larger pageSize cache key too
      const fetchSize = page === 1 && pageSize < DEFAULT_PAGE_SIZE ? DEFAULT_PAGE_SIZE : pageSize;

      const [orderRows, total] = await Promise.all([
        query<OrderRow>(
          `${ORDER_SELECT} ${where} ORDER BY ${orderBy} LIMIT {lim: UInt32} OFFSET {off: UInt32}`,
          { ...params, lim: fetchSize, off: offset },
          SEARCH_CACHE,
        ),
        getOrderCount(input.q?.trim() || undefined, filters),
      ]);
      if (diag) console.log(`[orders] listOrders ms=${Date.now() - t0} tokens=${searchTokens.join(",")} q=${input.q ?? ""} sort=${sort} dir=${dir} page=${page}`);

      const allData = orderRows.map(rowToDTO);
      const data = allData.slice(0, pageSize);
      const result: OrderListResult = { data, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), approximate: false };
      await searchCacheSet(cacheKey, result);

      // Dual write: also cache the DEFAULT_PAGE_SIZE key so the main UI benefits
      if (fetchSize > pageSize) {
        const altKey = `rows:${JSON.stringify({ q: input.q || null, page, pageSize: fetchSize, sort, dir, status: input.status || null, regionCode: input.regionCode || null, from: input.from || null, to: input.to || null, minTotal: input.minTotal ?? null, maxTotal: input.maxTotal ?? null })}`;
        const altResult: OrderListResult = { data: allData.slice(0, fetchSize), page, pageSize: fetchSize, total, totalPages: Math.max(1, Math.ceil(total / fetchSize)), approximate: false };
        await searchCacheSet(altKey, altResult);
      }

      return result;
    } catch (err) {
      mapDbError(err, "listOrders");
    }
  });
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
    const searchTokens = tokens.length > 0 && typesense.isEnabled()
      ? await Promise.all(tokens.map((t) => typesense.expandPrefix(t)))
      : tokens;
    const { clauses: baseClauses, params: baseParams } = buildWhereParts(searchTokens, filters);

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

    const [pageRows, total] = await Promise.all([
      query<OrderRow>(
        `${ORDER_SELECT} ${where} ORDER BY placedAt ${dirSQL}, orderId ${dirSQL} LIMIT {lim: UInt32}`,
        { ...allParams, lim: pageSize },
        SEARCH_CACHE,
      ),
      getOrderCount(input.q?.trim() || undefined, filters),
    ]);

    const data = (isNext ? pageRows : pageRows.reverse()).map(rowToDTO);
    const result: OrderListResult = { data, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), approximate: false };
    return result;
  } catch (err) {
    mapDbError(err, "listOrdersByCursor");
  }
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

    const newTokens = searchText.split(/\s+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t));
    typesense.indexTokens(newTokens.map((t) => ({ token: t }))).catch(() => {});
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
    const DATASET_END   = "2026-07-17";
    const DATASET_START = "2024-07-17";
    const d = new Date(`${DATASET_END}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 90);
    const from90 = d.toISOString().slice(0, 10);

    const [page1] = await Promise.all([
      listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc", from: from90, to: DATASET_END }),
      listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc", from: DATASET_START, to: DATASET_END }),
    ]);

    const tokens = new Set<string>();
    for (const order of page1.data) {
      if (order.customer.firstName) tokens.add(order.customer.firstName.toLowerCase());
      if (order.customer.lastName)  tokens.add(order.customer.lastName.toLowerCase());
      if (order.notes) {
        for (const w of order.notes.split(/\s+/)) {
          if (w.length >= 3 && !/^\d+$/.test(w)) tokens.add(w.toLowerCase());
        }
      }
    }

    const tokenList = [...tokens].slice(0, 100);
    console.log(`[orders:warmup] extracted ${tokenList.length} tokens from 90-day page-1 (${from90}→${DATASET_END}): ${tokenList.join(", ")}`);

    const layerCounts: Record<string, number> = {};
    for (const tok of tokenList) {
      const _diag = { src: "?" };
      await listOrders({ q: tok, page: 1, pageSize: 20, sort: "placedAt", dir: "desc", from: from90, to: DATASET_END }, _diag);
      layerCounts[_diag.src] = (layerCounts[_diag.src] ?? 0) + 1;
    }

    const summary = Object.entries(layerCounts).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`[orders:warmup] done — ${tokenList.length} tokens warmed: ${summary}`);
  } catch (e) {
    console.log(`[orders:warmup] error during warmup: ${e}`);
  }
})());

export async function getOrderCount(
  q: string | undefined,
  filters: ResolvedFilters,
): Promise<number> {
  const cacheKey = `count:${JSON.stringify({ q: q || null, ...filters })}`;
  const cachedCount = await searchCacheGet<number>(cacheKey);
  if (cachedCount != null) return cachedCount;

  return singleFlight(cacheKey, async () => {
  const tokens = (q?.trim() ?? "").split(/\s+/).filter(Boolean);

  if (
    tokens.length === 0 &&
    !filters.statuses.length &&
    filters.minTotal === null &&
    filters.maxTotal === null
  ) {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.from) { clauses.push(`date >= {from: Date}`); params["from"] = filters.from.slice(0, 10); }
    if (filters.to)   { clauses.push(`date <= {to: Date}`);   params["to"]   = filters.to.slice(0, 10); }
    if (filters.regionCodes.length) { clauses.push(`regionCode IN ({regionCodes: Array(String)})`); params["regionCodes"] = filters.regionCodes; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRows = await query<{ n: string }>(
      `SELECT sum(orderCount) AS n FROM daily_order_count ${where}`,
      params,
      SEARCH_CACHE,
    );
    const fastTotal = Number(countRows[0]?.n ?? 0);
    if (fastTotal > 0) {
      await searchCacheSet(cacheKey, fastTotal);
      return fastTotal;
    }
  }

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

  const searchTokens = tokens.length > 0 && typesense.isEnabled()
    ? await Promise.all(tokens.map((t) => typesense.expandPrefix(t)))
    : tokens;

  const { clauses, params } = buildWhereParts(searchTokens, filters);
  const where = whereSQL(clauses);
  const rows = await query<{ n: string }>(
    `SELECT count() AS n FROM orders ${where}`,
    params,
    SEARCH_CACHE,
  );
  const total = Number(rows[0]?.n ?? 0);
  await searchCacheSet(cacheKey, total);
  return total;
  }); // singleFlight
}
