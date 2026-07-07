import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
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
import { publishOrderEvent } from "./stream.service";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT: OrderSortField = "placedAt";
const DEFAULT_DIR: SortDir = "desc";
const COUNT_CAP = 10_000;
const COUNT_SENTINEL = COUNT_CAP + 1; // returned when result exceeds cap

const ORDER_STATUSES: readonly OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
];

// Raw-SQL sort expressions, also the sort-field whitelist. `customer` requires
// the customers join (see listOrders).
const SORT_SQL: Record<OrderSortField, string> = {
  placedAt: 'o."placedAt"',
  total: "o.total",
  status: "o.status",
  customer: 'c."lastName"',
  id: "o.id",
};

function normalizeSort(sort: string | null | undefined): OrderSortField {
  return sort != null && sort in SORT_SQL ? (sort as OrderSortField) : DEFAULT_SORT;
}

function normalizeDir(dir: string | null | undefined): SortDir {
  return dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;
}

/** Strip LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[%_]/g, "");
}

/** Per-token ILIKE conditions against the denormalized search_text column.
 *  Mirrors GCP OrderService.buildWhere's tokenization: split q on
 *  whitespace, AND one `o.search_text ILIKE` clause per token. */
export function buildSearchTextConditions(q: string | null | undefined): Prisma.Sql[] {
  const text = q?.trim();
  if (!text) return [];
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => Prisma.sql`o.search_text ILIKE ${`%${escapeLike(token)}%`}`);
}

/** True when any whitespace-split token of q is shorter than 3 characters —
 *  such a token's ILIKE '%tok%' matches too broadly to trust the exact-count
 *  cache blindly, so the count path goes through cappedCount instead. */
function hasShortToken(q: string | undefined): boolean {
  const text = q?.trim();
  if (!text) return false;
  return text.split(/\s+/).some((token) => token.length > 0 && token.length < 3);
}

// ---------- Filters ----------

export interface ResolvedFilters {
  statuses: OrderStatus[];
  regionIds: number[] | null; // null = no region filter; [] = filter that matches nothing
  from: Date | null;
  to: Date | null;
  minTotal: number | null;
  maxTotal: number | null;
  hasAny: boolean;
}

function parseList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function normalizeStatusList(csv: string | null | undefined): OrderStatus[] {
  return parseList(csv)
    .map((s) => s.toUpperCase())
    .filter((s): s is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(s));
}

/** UTC "today" — must match how placedAt (a tz-naive column populated with
 *  UTC wall-clock numerals) buckets into date columns like daily_summary.date
 *  (`placedAt::date`, a plain truncation with no timezone reinterpretation).
 *  Using the server's local machine time here would silently exclude/include
 *  the wrong day's rows whenever local time and UTC disagree on the date. */
export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateBoundary(value: string | null | undefined, edge: "start" | "end"): Date | null {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AppError("BAD_REQUEST", `invalid date filter: ${value}`);
  }
  // A date-only `to` should include the whole day. Use UTC end-of-day so it is
  // symmetric with a date-only `from`, which `new Date("YYYY-MM-DD")` parses as
  // UTC midnight — otherwise the two bounds straddle different timezones and the
  // final day's rows get dropped on non-UTC hosts.
  if (edge === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

/** Format a Date's UTC wall-clock components as a naive "YYYY-MM-DD HH:mm:ss.SSS"
 *  string with no timezone marker. `orders.placedAt` is a `timestamp without
 *  time zone` column populated with UTC wall-clock numerals (no conversion
 *  happens on read/write since the column has no zone attached) — but binding
 *  a raw JS `Date` object as a query parameter makes Prisma serialize it using
 *  the server process's LOCAL machine timezone, silently shifting every
 *  date-range filter by the local UTC offset. Binding this literal string
 *  instead sidesteps that serialization entirely. */
function toNaiveUtcTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function parseNumber(value: number | null | undefined, name: string): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new AppError("BAD_REQUEST", `invalid ${name}`);
  return n;
}

export async function resolveFilters(input: OrderFilterInput): Promise<ResolvedFilters> {
  const statuses = normalizeStatusList(input.status);

  const regionCodes = parseList(input.regionCode);
  let regionIds: number[] | null = null;
  if (regionCodes.length) {
    const regions = await prisma.region.findMany({
      where: { code: { in: regionCodes } },
      select: { id: true },
    });
    regionIds = regions.map((r) => r.id); // [] when no code matches -> empty result
  }

  const from = parseDateBoundary(input.from, "start");
  const toInput = input.to || (input.from ? todayDateString() : input.to);
  const to = parseDateBoundary(toInput, "end");
  const minTotal = parseNumber(input.minTotal, "minTotal");
  const maxTotal = parseNumber(input.maxTotal, "maxTotal");

  const hasAny =
    statuses.length > 0 ||
    regionIds !== null ||
    from !== null ||
    to !== null ||
    minTotal !== null ||
    maxTotal !== null;

  return { statuses, regionIds, from, to, minTotal, maxTotal, hasAny };
}

/**
 * SQL conditions for the resolved filters — all on `orders` columns (indexable),
 * referencing the `o` alias. Reused by the aggregates service so both endpoints
 * apply identical filter semantics.
 */
export function buildFilterConditions(f: ResolvedFilters): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (f.statuses.length) c.push(Prisma.sql`o.status = ANY(${f.statuses}::text[]::"OrderStatus"[])`);
  if (f.regionIds !== null) c.push(Prisma.sql`o."regionId" = ANY(${f.regionIds})`);
  if (f.from) c.push(Prisma.sql`o."placedAt" >= ${toNaiveUtcTimestamp(f.from)}::timestamp`);
  if (f.to) c.push(Prisma.sql`o."placedAt" <= ${toNaiveUtcTimestamp(f.to)}::timestamp`);
  if (f.minTotal !== null) c.push(Prisma.sql`o.total >= ${f.minTotal}`);
  if (f.maxTotal !== null) c.push(Prisma.sql`o.total <= ${f.maxTotal}`);
  return c;
}

export function whereClause(conds: Prisma.Sql[]): Prisma.Sql {
  return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
}

// ---------- List ----------

export async function listOrders(input: OrderListInput): Promise<OrderListResult> {
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const sort = normalizeSort(input.sort);
  const dir = normalizeDir(input.dir);
  const q = input.q?.trim();
  const offset = (page - 1) * pageSize;

  try {
    const filters = await resolveFilters(input);
    const conds = [...buildSearchTextConditions(q), ...buildFilterConditions(filters)];
    const whereSql = whereClause(conds);

    // Customer join is needed ONLY for sort=customer — search_text already
    // carries the customer's name, so text search never needs to touch
    // `customers` at all.
    const customerJoin =
      sort === "customer" ? Prisma.sql`JOIN customers c ON c.id = o."customerId"` : Prisma.empty;

    const sortSql = Prisma.raw(SORT_SQL[sort]);
    const orderBy = (flip: boolean) => {
      const d = flip ? (dir === "asc" ? "desc" : "asc") : dir;
      const dirSql = Prisma.raw(d === "asc" ? "ASC" : "DESC");
      const tiebreakerColSql =
        sort === "placedAt"
          ? Prisma.raw(`o.id ${d === "asc" ? "ASC" : "DESC"}`)
          : Prisma.raw(`o."placedAt" ${d === "asc" ? "DESC" : "ASC"}, o.id ${d === "asc" ? "DESC" : "ASC"}`);
      return Prisma.sql`${sortSql} ${dirSql}, ${tiebreakerColSql}`;
    };

    const cacheKey = buildCountCacheKey(q, filters);
    // Same rollup shortcut as getExactAggregateTotal (aggregates.service.ts):
    // a pure date-range query — the default/unfiltered view's own first hit
    // on a given day's range included — would otherwise pay a synchronous
    // COUNT(*) on every cache miss. Without this, the chart's total gets fast
    // via the rollup but the list's own pagination total would not.
    // Awaited before the id fetch (rather than in parallel) because whether
    // this is the LAST page — and therefore whether to reverse-scan — can't
    // be known until total/totalPages is known. In practice this costs
    // nothing extra: count is a count_cache hit or a rollup sum, both cheap.
    const rawTotal = await (isPureDateRangeQuery(q, filters)
      ? sumDailyOrderCount(filters.from, filters.to)
      : hasShortToken(q)
        ? cappedCount(cacheKey, whereSql)
        : cachedCount(cacheKey, () => exactCount(whereSql)));
    const approximate = rawTotal === COUNT_SENTINEL;
    const total = approximate ? COUNT_CAP : rawTotal;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    // Last-page reverse-scan: OFFSET cost scales with how deep into the
    // result set it skips — cheap for page 1, but LIMIT 20 OFFSET ~4,000,000
    // forces Postgres to walk/sort past nearly the whole table first. Scanning
    // from the OPPOSITE end with the ORDER BY flipped is exactly as cheap as
    // page 1 (same index, same direction of travel), then the rows are
    // reversed back in memory to restore normal display order. Generalized to
    // any sort/dir, not just the default placedAt/desc.
    const isLastPage = totalPages > 1 && page === totalPages;
    let idRows: { id: number }[];
    if (isLastPage) {
      const remainder = total - (totalPages - 1) * pageSize;
      const reverseQuery = Prisma.sql`
        SELECT o.id
        FROM orders o ${customerJoin}
        ${whereSql}
        ORDER BY ${orderBy(true)}
        LIMIT ${remainder} OFFSET 0`;
      idRows = (await prisma.$queryRaw<{ id: number }[]>(reverseQuery)).reverse();
    } else {
      const pageQuery = Prisma.sql`
        SELECT o.id
        FROM orders o ${customerJoin}
        ${whereSql}
        ORDER BY ${orderBy(false)}
        LIMIT ${pageSize} OFFSET ${offset}`;
      idRows = await prisma.$queryRaw<{ id: number }[]>(pageQuery);
    }

    const data = await hydrateOrders(idRows.map((r) => r.id));
    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate };
    if (input.facets) result.facets = await computeFacets(whereSql);
    return result;
  } catch (err) {
    mapDbError(err, "listOrders");
  }
}

/**
 * Keyset (cursor) fetch for the default placedAt/desc sort only — Prev/Next
 * on this sort should never pay OFFSET's page-depth-scaling cost even one
 * page in. `dir: "next"` seeks strictly past the cursor in display order;
 * `dir: "prev"` seeks backward (a flipped comparison + flipped ORDER BY),
 * then the returned rows are reversed back to newest-first before returning
 * — a backward seek reads oldest-first off the cursor. total/totalPages come
 * from the same count path as listOrders (typically a cache hit for an
 * unchanged filter signature, so effectively free).
 */
export async function listOrdersByCursor(
  input: OrderListInput & { cursorId: number; cursorPlacedAt: string; cursorDir: "next" | "prev" },
): Promise<OrderListResult> {
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const q = input.q?.trim();

  try {
    const filters = await resolveFilters(input);
    const baseConds = [...buildSearchTextConditions(q), ...buildFilterConditions(filters)];
    const baseWhereSql = whereClause(baseConds);
    const cursorTimestamp = toNaiveUtcTimestamp(new Date(input.cursorPlacedAt));
    const isNext = input.cursorDir === "next";
    // Forward: strictly older than the cursor (newest-first display order).
    // Backward: strictly newer than the cursor, scanned oldest-first off the
    // cursor, then reversed back to newest-first below.
    const cursorCond = isNext
      ? Prisma.sql`(o."placedAt", o.id) < (${cursorTimestamp}::timestamp, ${input.cursorId})`
      : Prisma.sql`(o."placedAt", o.id) > (${cursorTimestamp}::timestamp, ${input.cursorId})`;
    const whereSql = whereClause([...baseConds, cursorCond]);
    const dirSql = Prisma.raw(isNext ? "DESC" : "ASC");

    const pageQuery = Prisma.sql`
      SELECT o.id
      FROM orders o
      ${whereSql}
      ORDER BY o."placedAt" ${dirSql}, o.id ${dirSql}
      LIMIT ${pageSize}`;

    const cacheKey = buildCountCacheKey(q, filters);
    const rawTotal = await (isPureDateRangeQuery(q, filters)
      ? sumDailyOrderCount(filters.from, filters.to)
      : hasShortToken(q)
        ? cappedCount(cacheKey, baseWhereSql)
        : cachedCount(cacheKey, () => exactCount(baseWhereSql)));
    const approximate = rawTotal === COUNT_SENTINEL;
    const total = approximate ? COUNT_CAP : rawTotal;

    const rows = await prisma.$queryRaw<{ id: number }[]>(pageQuery);
    const idRows = isNext ? rows : rows.reverse();

    const data = await hydrateOrders(idRows.map((r) => r.id));
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate };
    if (input.facets) result.facets = await computeFacets(baseWhereSql);
    return result;
  } catch (err) {
    mapDbError(err, "listOrdersByCursor");
  }
}

export function buildCountCacheKey(q: string | undefined, filters: ResolvedFilters): string {
  return [
    `q=${(q ?? "").toLowerCase()}`,
    `status=${filters.statuses.join(",")}`,
    `regionIds=${(filters.regionIds ?? []).sort((a, b) => a - b).join(",")}`,
    `from=${filters.from?.toISOString() ?? ""}`,
    `to=${filters.to?.toISOString() ?? ""}`,
    `minTotal=${filters.minTotal ?? ""}`,
    `maxTotal=${filters.maxTotal ?? ""}`,
  ].join("&");
}

/** Exact-count cache, keyed by the full filter signature. 30-day TTL, fail-open
 *  (a cache read/write failure never breaks a search — it just recomputes). */
export async function cachedCount(cacheKey: string, compute: () => Promise<number>): Promise<number> {
  try {
    const hit = await prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT total FROM count_cache
      WHERE cache_key = ${cacheKey}
        AND cached_at > NOW() - INTERVAL '30 days'
      LIMIT 1`);
    if (hit.length > 0) return Number(hit[0].total);
  } catch {}
  const total = await compute();
  prisma.$queryRaw(Prisma.sql`
    INSERT INTO count_cache (cache_key, total, cached_at)
    VALUES (${cacheKey}, ${BigInt(total)}, NOW())
    ON CONFLICT (cache_key) DO UPDATE SET total = ${BigInt(total)}, cached_at = NOW()`
  ).catch(() => {});
  return total;
}

/** Exact count for pagination bounds — every case goes through the same query. */
export async function exactCount(whereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count
    FROM orders o ${whereSql}`);
  return Number(rows[0]?.count ?? 0);
}

/** Capped exact count for broad short-token searches. LIMIT inside the
 *  subquery lets Postgres stop as soon as it's found COUNT_SENTINEL matching
 *  rows instead of scanning every match of a wide ILIKE pattern. A result
 *  under the sentinel IS the exact count (safe to cache); a result AT the
 *  sentinel means "more than COUNT_CAP" and is never cached, since it isn't
 *  exact — the frontend follows up with an uncapped /count request to get
 *  the real number in the background. */
export async function cappedCount(cacheKey: string, whereSql: Prisma.Sql): Promise<number> {
  try {
    const hit = await prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT total FROM count_cache
      WHERE cache_key = ${cacheKey}
        AND cached_at > NOW() - INTERVAL '30 days'
      LIMIT 1`);
    if (hit.length > 0) return Number(hit[0].total);
  } catch {}

  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count
    FROM (SELECT 1 FROM orders o ${whereSql} LIMIT ${COUNT_SENTINEL}) _cap`);
  const total = Number(rows[0]?.count ?? 0);
  if (total === COUNT_SENTINEL) return COUNT_SENTINEL;

  prisma.$queryRaw(Prisma.sql`
    INSERT INTO count_cache (cache_key, total, cached_at)
    VALUES (${cacheKey}, ${BigInt(total)}, NOW())
    ON CONFLICT (cache_key) DO UPDATE SET total = ${BigInt(total)}, cached_at = NOW()`
  ).catch(() => {});
  return total;
}

/** True when the only active filter is (optionally) a date range — no search
 *  text, status, region, or total-bounds filter. This is the exact shape the
 *  DailyOrderCount rollup can answer by summing rather than a live COUNT(*). */
export function isPureDateRangeQuery(q: string | undefined, filters: ResolvedFilters): boolean {
  return (
    !q?.trim() &&
    filters.statuses.length === 0 &&
    filters.regionIds === null &&
    filters.minTotal === null &&
    filters.maxTotal === null
  );
}

/** Zero-lag exact total for a pure date-range query — sums the DailyOrderCount
 *  rollup (kept in sync synchronously in createOrder's own transaction)
 *  instead of running a live COUNT(*) over the matching orders. A brush drag
 *  lands on a never-before-cached range essentially every time, so
 *  count_cache can't help there; this rollup can, since it has no per-filter
 *  combinatorial explosion (one row per day, period). */
export async function sumDailyOrderCount(from: Date | null, to: Date | null): Promise<number> {
  const conds: Prisma.Sql[] = [];
  if (from) conds.push(Prisma.sql`date >= ${toNaiveUtcTimestamp(from)}::date`);
  if (to) conds.push(Prisma.sql`date <= ${toNaiveUtcTimestamp(to)}::date`);
  const rows = await prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
    SELECT COALESCE(SUM("totalOrders"), 0)::bigint AS total
    FROM daily_order_count ${whereClause(conds)}`);
  return Number(rows[0]?.total ?? 0);
}

/**
 * Sidebar facet counts (per status, per region) for the current filter set.
 * Always exact — no cap.
 */
async function computeFacets(whereSql: Prisma.Sql): Promise<OrderFacets> {
  const rows = await prisma.$queryRaw<{ dim: string; key: string | null; n: bigint }[]>(Prisma.sql`
    WITH base AS (
      SELECT o.status, o."regionId" FROM orders o ${whereSql}
    )
    SELECT 'status' AS dim, status::text AS key, count(*)::bigint AS n FROM base GROUP BY status
    UNION ALL
    SELECT 'region' AS dim, "regionId"::text AS key, count(*)::bigint AS n FROM base GROUP BY "regionId"`);

  const status: FacetCount[] = [];
  const regionCount = new Map<number, number>();
  for (const r of rows) {
    const n = Number(r.n);
    if (r.dim === "status") {
      status.push({ value: r.key ?? "UNKNOWN", count: n });
    } else if (r.key != null) {
      regionCount.set(Number(r.key), n);
    }
  }

  const regionIds = [...regionCount.keys()];
  const regions = regionIds.length
    ? await prisma.region.findMany({ where: { id: { in: regionIds } }, select: { id: true, code: true } })
    : [];
  const codeById = new Map(regions.map((r) => [r.id, r.code]));
  const region: FacetCount[] = regionIds.map((id) => ({
    value: codeById.get(id) ?? String(id),
    count: regionCount.get(id)!,
  }));

  status.sort((a, b) => b.count - a.count);
  region.sort((a, b) => b.count - a.count);
  return { status, region, approximate: false };
}

/** Load full order DTOs for the given ids, preserving the id ordering. */
async function hydrateOrders(ids: number[]): Promise<OrderDTO[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<
    {
      id: number;
      status: OrderStatus;
      total: number;
      currency: string;
      notes: string | null;
      placedAt: Date;
      customer: { id: number; email: string; firstName: string; lastName: string };
      region: { id: number; code: string; name: string };
      items: OrderItemDTO[];
    }[]
  >(Prisma.sql`
    WITH selected(id, ord) AS (
      SELECT * FROM unnest(${ids}::int[]) WITH ORDINALITY
    )
    SELECT
      o.id,
      o.status::text AS status,
      o.total::float8 AS total,
      o.currency,
      o.notes,
      o."placedAt",
      json_build_object(
        'id', c.id,
        'email', c.email,
        'firstName', c."firstName",
        'lastName', c."lastName"
      ) AS customer,
      json_build_object(
        'id', r.id,
        'code', r.code,
        'name', r.name
      ) AS region,
      coalesce(
        json_agg(
          json_build_object(
            'id', oi.id,
            'productId', oi."productId",
            'quantity', oi.quantity,
            'unitPrice', oi."unitPrice"::float8,
            'discount', oi.discount::float8,
            'product', json_build_object(
              'id', p.id,
              'sku', p.sku,
              'name', p.name
            )
          )
          ORDER BY oi.id
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM selected s
    JOIN orders o       ON o.id = s.id
    JOIN customers c    ON c.id = o."customerId"
    JOIN regions r      ON r.id = o."regionId"
    LEFT JOIN order_items oi ON oi."orderId" = o.id
    LEFT JOIN products p     ON p.id = oi."productId"
    GROUP BY s.ord, o.id, c.id, r.id
    ORDER BY s.ord`);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    total: Number(r.total),
    currency: r.currency,
    notes: r.notes,
    placedAt: r.placedAt.toISOString(),
    customer: r.customer,
    region: r.region,
    items: r.items,
  }));
}

// Pre-warm count cache for first-page customer tokens on module load.
// Guard: DATABASE_URL is absent during `next build` static analysis — skip then.
void (process.env.DATABASE_URL && (async () => {
  try {
    const rows = await prisma.$queryRaw<{ firstName: string; lastName: string }[]>(Prisma.sql`
      SELECT DISTINCT c."firstName", c."lastName"
      FROM (SELECT "customerId" FROM orders ORDER BY "placedAt" DESC LIMIT 20) recent
      JOIN customers c ON c.id = recent."customerId"`);
    const tokens = new Set<string>();
    for (const r of rows) {
      if (r.firstName?.trim()) tokens.add(r.firstName.trim().toLowerCase());
      if (r.lastName?.trim()) tokens.add(r.lastName.trim().toLowerCase());
    }
    for (const token of tokens) {
      const key = `q=${token}&status=&regionIds=&from=&to=&minTotal=&maxTotal=`;
      const hit = await prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT total FROM count_cache
        WHERE cache_key = ${key} AND cached_at > NOW() - INTERVAL '30 days'
        LIMIT 1`).catch(() => [] as { total: bigint }[]);
      if (hit.length > 0) continue;

      const pattern = `%${token}%`;
      const result = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM orders o WHERE o.search_text ILIKE ${pattern}`
      ).catch(() => null);
      if (!result) continue;
      const total = Number(result[0]?.count ?? 0);
      await prisma.$queryRaw(Prisma.sql`
        INSERT INTO count_cache (cache_key, total, cached_at) VALUES (${key}, ${BigInt(total)}, NOW())
        ON CONFLICT (cache_key) DO UPDATE SET total = ${BigInt(total)}, cached_at = NOW()`
      ).catch(() => {});
    }
  } catch {}
})());

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (!input.customerId || !input.regionId || !Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("BAD_REQUEST", "customerId, regionId, and at least one item are required");
  }
  for (const it of input.items) {
    if (!it.productId || it.quantity <= 0 || it.unitPrice < 0) {
      throw new AppError(
        "BAD_REQUEST",
        "each item needs productId, a positive quantity, and a non-negative unitPrice",
      );
    }
  }

  const total = input.items.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice * (1 - (it.discount ?? 0)),
    0,
  );

  try {
    // The outbox row (order_events) is inserted in the SAME transaction as
    // the order + its items, so there's no dual-write gap: if this commits,
    // scripts/aggregates-worker.ts is guaranteed to eventually see it and
    // apply the 7 aggregate-table writes that used to happen synchronously/
    // fire-and-forget right here.
    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          customerId: input.customerId,
          regionId: input.regionId,
          currency: input.currency ?? "USD",
          notes: input.notes ?? null,
          total,
          items: {
            create: input.items.map((it) => ({
              productId: it.productId,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              discount: it.discount ?? 0,
            })),
          },
        },
      });
      await tx.orderEvent.create({ data: { orderId: order.id } });
      // Synchronous, same-transaction rollup so a pure date-range total
      // (the common brush-drag/default-view case) can be summed instantly
      // with zero replication lag — see DailyOrderCount in schema.prisma.
      // CURRENT_DATE (not a JS Date round-tripped through serialization,
      // which shifts by the app server's local UTC offset — see
      // toNaiveUtcTimestamp's comment above) is evaluated in this same
      // transaction/session as placedAt's own `now()` default, so the two
      // always bucket into the same calendar day.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO daily_order_count (date, "totalOrders")
        VALUES (CURRENT_DATE, 1)
        ON CONFLICT (date) DO UPDATE SET "totalOrders" = daily_order_count."totalOrders" + 1`);
      return order;
    });
    let categorySlug: string | undefined;
    if (input.items.length > 0) {
      try {
        const product = await prisma.product.findUnique({
          where: { id: input.items[0].productId },
          include: { category: true },
        });
        categorySlug = product?.category?.name ?? undefined;
      } catch {
        // non-fatal — SSE event fires without the slug
      }
    }

    publishOrderEvent({
      id: created.id,
      total: Number(created.total),
      customerId: created.customerId,
      placedAt: created.placedAt.toISOString(),
      categorySlug,
    }).catch(() => {});
    // count_cache has no active invalidation otherwise (just a 30-day passive
    // TTL) — a new order makes some cached exact counts a potential
    // undercount until something forces a recompute. Scoped rather than a
    // blanket wipe: filter-less (q=) entries cover every order so they must
    // always be cleared; a q=<token> entry only needs clearing if this
    // order's own search_text actually matches that token — an unrelated
    // search term shouldn't be evicted by an unrelated write (this also
    // stops every write from defeating the pre-warm block above).
    // created.searchText is already populated here: fn_order_search_text is a
    // BEFORE INSERT trigger, so tx.order.create()'s RETURNING reflects it.
    const searchText = created.searchText ?? "";
    prisma
      .$executeRaw(Prisma.sql`
        DELETE FROM count_cache WHERE
          substring(cache_key from 'q=([^&]*)') = ''
          OR (${searchText} <> '' AND ${searchText} ILIKE '%' || substring(cache_key from 'q=([^&]*)') || '%')`)
      .catch(() => {});
    return {
      id: created.id,
      status: created.status,
      total: Number(created.total),
      placedAt: created.placedAt.toISOString(),
    };
  } catch (err) {
    mapDbError(err, "createOrder");
  }
}
