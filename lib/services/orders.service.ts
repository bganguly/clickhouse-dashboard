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
import {
  updateDailyCustomerCategorySummary,
  updateDailyCustomerTokenCategoryRollup,
  updateDailyCustomerTokenCategorySummary,
  updateDailyCustomerTokenOrderSummary,
  updateDailyFilterCategorySummary,
  updateDailySummary,
  updateDailyStatusCategorySummary,
  updateOrderCategoryFacts,
} from "./aggregates.service";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT: OrderSortField = "placedAt";
const DEFAULT_DIR: SortDir = "desc";

// Stop counting matches at this bound; a broad result reports an approximate
// total/totalPages instead of paying for an exact count over millions of rows.
const COUNT_CAP = 10_000;
// Max customers we enumerate for the `customerId = ANY(ids)` text plan. Above
// this a query is dense enough (for example "frank") that materializing and
// sorting all matching order ids is slower than walking the sort index and
// testing the text predicate as rows are encountered.
const TEXT_MATCH_CAP = 5_000;
// Upper bound on rows scanned for facet counts.
const FACET_CAP = 50_000;
const TEXT_PROBE_TTL_MS = 60_000;

const ORDER_STATUSES: readonly OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
];

/** Prisma orderBy clauses for the unfiltered path. */
const ORDER_BY: Record<OrderSortField, (dir: SortDir) => Prisma.OrderOrderByWithRelationInput[]> = {
  placedAt: (dir) => [{ placedAt: dir }, { id: dir }],
  total: (dir) => [{ total: dir }, { placedAt: "desc" }, { id: "desc" }],
  status: (dir) => [{ status: dir }, { placedAt: "desc" }, { id: "desc" }],
  customer: (dir) => [{ customer: { lastName: dir } }, { placedAt: "desc" }, { id: "desc" }],
  id: (dir) => [{ id: dir }],
};

// Raw-SQL sort expressions for the search/filter path. Keyed by the validated
// whitelist, so these fragments are never attacker-controlled. `customer`
// requires the customers join (see pageNeedsJoin).
const SORT_SQL: Record<OrderSortField, string> = {
  placedAt: 'o."placedAt"',
  total: "o.total",
  status: "o.status",
  customer: 'c."lastName"',
  id: "o.id",
};

function normalizeSort(sort: string | null | undefined): OrderSortField {
  return sort != null && sort in ORDER_BY ? (sort as OrderSortField) : DEFAULT_SORT;
}

function normalizeDir(dir: string | null | undefined): SortDir {
  return dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;
}

function searchToken(q: string | null | undefined): string | null {
  const token = q?.trim().toLowerCase();
  return token && /^[a-z0-9._@-]+$/.test(token) ? token : null;
}

/** Strip LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[%_]/g, "");
}

export interface TextProbe {
  pattern: string;
  token: string | null;
  tokenOrderReady: boolean;
  customerRows: { id: number }[];
  notesHaveMatches: boolean;
}

export interface TokenProbe {
  token: string | null;
  tokenOrderReady: boolean;
  notesHaveMatches: boolean;
}

const textProbeCache = new Map<string, { expiresAt: number; promise: Promise<TextProbe> }>();
const noteProbeCache = new Map<string, { expiresAt: number; promise: Promise<boolean> }>();
const tokenProbeCache = new Map<string, { expiresAt: number; promise: Promise<TokenProbe> }>();

function clearTextProbeCaches(): void {
  textProbeCache.clear();
  noteProbeCache.clear();
  tokenProbeCache.clear();
}

export function getNotesHaveMatches(q: string): Promise<boolean> {
  const text = q.trim();
  const key = text.toLowerCase();
  const now = Date.now();
  const cached = noteProbeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const pattern = `%${escapeLike(text)}%`;
  const promise = prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM orders WHERE notes ILIKE ${pattern} LIMIT 1`).then((rows) => rows.length > 0);

  noteProbeCache.set(key, { expiresAt: now + TEXT_PROBE_TTL_MS, promise });
  promise.catch(() => noteProbeCache.delete(key));
  return promise;
}

export function getTextProbe(q: string): Promise<TextProbe> {
  const text = q.trim();
  const key = text.toLowerCase();
  const now = Date.now();
  const cached = textProbeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const pattern = `%${escapeLike(text)}%`;
  const token = searchToken(text);
  const promise = Promise.all([
    token
      ? prisma.$queryRaw<{ ready: boolean }[]>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM daily_customer_token_order_summary
            WHERE token = ${token}
            LIMIT 1
          ) AND EXISTS (
            SELECT 1
            FROM customers
            WHERE lower("firstName") = ${token}
               OR lower("lastName") = ${token}
            LIMIT 1
          ) AS ready`)
      : Promise.resolve([{ ready: false }]),
    prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT id FROM customers
      WHERE ("firstName" || ' ' || "lastName") ILIKE ${pattern}
      LIMIT ${TEXT_MATCH_CAP + 1}`),
    getNotesHaveMatches(text),
  ]).then(([tokenReady, customerRows, notesHaveMatches]) => ({
    pattern,
    token,
    tokenOrderReady: Boolean(tokenReady[0]?.ready),
    customerRows,
    notesHaveMatches,
  }));

  textProbeCache.set(key, { expiresAt: now + TEXT_PROBE_TTL_MS, promise });
  promise.catch(() => textProbeCache.delete(key));
  return promise;
}

export function getTokenProbe(q: string): Promise<TokenProbe> {
  const text = q.trim();
  const key = text.toLowerCase();
  const now = Date.now();
  const cached = tokenProbeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const token = searchToken(text);
  const promise = Promise.all([
    token
      ? prisma.$queryRaw<{ ready: boolean }[]>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM daily_customer_token_order_summary
            WHERE token = ${token}
            LIMIT 1
          ) AND EXISTS (
            SELECT 1
            FROM customers
            WHERE lower("firstName") = ${token}
               OR lower("lastName") = ${token}
            LIMIT 1
          ) AS ready`)
      : Promise.resolve([{ ready: false }]),
    getNotesHaveMatches(text),
  ]).then(([tokenReady, notesHaveMatches]) => ({
    token,
    tokenOrderReady: Boolean(tokenReady[0]?.ready),
    notesHaveMatches,
  }));

  tokenProbeCache.set(key, { expiresAt: now + TEXT_PROBE_TTL_MS, promise });
  promise.catch(() => tokenProbeCache.delete(key));
  return promise;
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

export function todayDateString(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
  if (f.from) c.push(Prisma.sql`o."placedAt" >= ${f.from}`);
  if (f.to) c.push(Prisma.sql`o."placedAt" <= ${f.to}`);
  if (f.minTotal !== null) c.push(Prisma.sql`o.total >= ${f.minTotal}`);
  if (f.maxTotal !== null) c.push(Prisma.sql`o.total <= ${f.maxTotal}`);
  return c;
}

function whereClause(conds: Prisma.Sql[]): Prisma.Sql {
  return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
}

export interface TextSearchSql {
  /** Escaped ILIKE pattern for the text query. */
  pattern: string;
  /** Join that restricts `orders o` to matching text rows. Empty for broad text. */
  matchJoin: Prisma.Sql;
  /** Extra WHERE condition for broad text searches. Null for indexed id joins. */
  condition: Prisma.Sql | null;
  /** Whether the caller must join `customers c` because `condition` references it. */
  needsCustomerJoin: boolean;
  /** True when the customer side can use exact token equality instead of substring matching. */
  exactCustomerToken: boolean;
  /** True when both customer text and order notes have no matches. */
  noMatches: boolean;
}

/**
 * Build an index-friendly text search plan shared by the list and aggregate
 * endpoints. For selective customer matches, avoid `customerId = ANY(...) OR
 * notes ILIKE ...` on the orders table; that OR can collapse into a slow scan.
 * Instead, union indexed customer-id matches with indexed notes matches, then
 * join orders by id.
 */
export async function buildTextSearchSql(q: string | null | undefined): Promise<TextSearchSql | null> {
  const text = q?.trim();
  if (!text) return null;

  const tokenProbe = await getTokenProbe(text);
  if (tokenProbe.token && tokenProbe.tokenOrderReady) {
    const pattern = `%${escapeLike(text)}%`;
    const noteCondition = tokenProbe.notesHaveMatches
      ? Prisma.sql`OR o.notes ILIKE ${pattern}`
      : Prisma.empty;
    return {
      pattern,
      matchJoin: Prisma.empty,
      condition: Prisma.sql`(
        lower(c."firstName") = ${tokenProbe.token}
        OR lower(c."lastName") = ${tokenProbe.token}
        ${noteCondition}
      )`,
      needsCustomerJoin: true,
      exactCustomerToken: true,
      noMatches: false,
    };
  }
  if (/^\d+$/.test(text) && tokenProbe.notesHaveMatches) {
    const pattern = `%${escapeLike(text)}%`;
    return {
      pattern,
      matchJoin: Prisma.empty,
      condition: Prisma.sql`o.notes ILIKE ${pattern}`,
      needsCustomerJoin: false,
      exactCustomerToken: false,
      noMatches: false,
    };
  }

  const {
    pattern,
    token,
    tokenOrderReady,
    customerRows: custRows,
    notesHaveMatches,
  } = await getTextProbe(text);

  if (token && tokenOrderReady) {
      const noteCondition = notesHaveMatches
        ? Prisma.sql`OR o.notes ILIKE ${pattern}`
        : Prisma.empty;
      return {
        pattern,
        matchJoin: Prisma.empty,
        condition: Prisma.sql`(
          lower(c."firstName") = ${token}
          OR lower(c."lastName") = ${token}
          ${noteCondition}
        )`,
        needsCustomerJoin: true,
        exactCustomerToken: true,
        noMatches: false,
      };
  }

  if (custRows.length > TEXT_MATCH_CAP) {
    const noteCondition = notesHaveMatches ? Prisma.sql`OR o.notes ILIKE ${pattern}` : Prisma.empty;
    return {
      pattern,
      matchJoin: Prisma.empty,
      condition: Prisma.sql`((c."firstName" || ' ' || c."lastName") ILIKE ${pattern} ${noteCondition})`,
      needsCustomerJoin: true,
      exactCustomerToken: false,
      noMatches: false,
    };
  }

  const customerIds = custRows.map((r) => r.id);
  if (customerIds.length === 0 && notesHaveMatches) {
    return {
      pattern,
      matchJoin: Prisma.empty,
      condition: Prisma.sql`o.notes ILIKE ${pattern}`,
      needsCustomerJoin: false,
      exactCustomerToken: false,
      noMatches: false,
    };
  }

  if (customerIds.length === 0 && !notesHaveMatches) {
    return {
      pattern,
      matchJoin: Prisma.empty,
      condition: null,
      needsCustomerJoin: false,
      exactCustomerToken: false,
      noMatches: true,
    };
  }

  const customerMatches = customerIds.length
    ? Prisma.sql`SELECT id FROM orders WHERE "customerId" = ANY(${customerIds})`
    : Prisma.sql`SELECT id FROM orders WHERE false`;
  const noteMatches = notesHaveMatches
    ? Prisma.sql`UNION SELECT id FROM orders WHERE notes ILIKE ${pattern}`
    : Prisma.empty;

  return {
    pattern,
    matchJoin: Prisma.sql`
      JOIN (
        ${customerMatches}
        ${noteMatches}
      ) text_match ON text_match.id = o.id`,
    condition: null,
    needsCustomerJoin: false,
    exactCustomerToken: false,
    noMatches: false,
  };
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

    // --- Unfiltered path: every sort field is B-tree indexed, so Prisma's
    // index-backed findMany + exact count is fast even at deep offsets.
    if (!q && !filters.hasAny) {
      const orderBy = ORDER_BY[sort](dir);
      const [idRows, total] = await Promise.all([
        prisma.order.findMany({ skip: offset, take: pageSize, orderBy, select: { id: true } }),
        prisma.order.count(),
      ]);
      const data = await hydrateOrders(idRows.map((r) => r.id));
      const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
      const result: OrderListResult = {
        data,
        page,
        pageSize,
        total,
        totalPages,
        approximate: false,
      };
      if (input.facets) result.facets = await computeFacets(Prisma.empty, Prisma.empty);
      return result;
    }

    // --- Search / filter path (raw SQL so the trgm + B-tree indexes apply and
    // the count stays capped).
    const filterConds = buildFilterConditions(filters);
    const customerJoin = Prisma.sql`JOIN customers c ON c.id = o."customerId"`;

    const textSearch = await buildTextSearchSql(q);
    if (textSearch?.noMatches) {
      const result: OrderListResult = {
        data: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        approximate: false,
      };
      if (input.facets) result.facets = { status: [], region: [], approximate: false };
      return result;
    }

    const conds = [...(textSearch?.condition ? [textSearch.condition] : []), ...filterConds];
    const whereSql = whereClause(conds);
    const searchJoin = textSearch?.matchJoin ?? Prisma.empty;
    // The customers join is needed wherever the predicate/sort references `c`.
    const filterWhereJoin = textSearch?.needsCustomerJoin ? customerJoin : searchJoin;

    // Is the result bounded by selective filters alone (regardless of q breadth)?
    const filterBounded =
      filters.hasAny &&
      filterConds.length > 0 &&
      (await cappedCount(Prisma.empty, whereClause(filterConds))) <=
        COUNT_CAP;

    const sortSql = Prisma.raw(SORT_SQL[sort]);
    const dirSql = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
    const tiebreakerColSql =
      sort === "placedAt"
        ? Prisma.raw(`o.id ${dir === "asc" ? "ASC" : "DESC"}`)
        : Prisma.raw('o."placedAt" DESC, o.id DESC');
    const tiebreakerAliasSql =
      sort === "placedAt"
        ? Prisma.raw(`id ${dir === "asc" ? "ASC" : "DESC"}`)
        : Prisma.raw("placed_at DESC, id DESC");

    // The sort-index walk only short-circuits when the matching set is large,
    // dense, and aligned to the sort. Otherwise filter-first (materialize the
    // matches, then sort) so a sparse/customer-sorted result stays fast.
    const selectiveText = Boolean(q) && !textSearch?.needsCustomerJoin;
    const useWalk = sort !== "customer" && !selectiveText && !filterBounded;

    const pageJoin =
      textSearch?.needsCustomerJoin || sort === "customer" ? customerJoin : Prisma.empty;
    const baseJoin = Prisma.sql`${searchJoin} ${pageJoin}`;
    const andFilterSql = filterConds.length
      ? Prisma.sql`AND ${Prisma.join(filterConds, " AND ")}`
      : Prisma.empty;
    const candidateLimit = offset + pageSize;
    const noteCandidates =
      q && q.length >= 3 && textSearch?.needsCustomerJoin
        ? Prisma.sql`
            UNION
            SELECT id, sortkey, placed_at FROM (
              SELECT o.id AS id, ${sortSql} AS sortkey, o."placedAt" AS placed_at
              FROM orders o
              WHERE o.notes ILIKE ${textSearch.pattern}
              ${andFilterSql}
              ORDER BY ${sortSql} ${dirSql}, ${tiebreakerColSql}
              LIMIT ${candidateLimit}
            ) note_candidates`
        : Prisma.empty;

    const pageQuery = textSearch?.exactCustomerToken && sort !== "customer"
      ? Prisma.sql`
          SELECT o.id
          FROM orders o
          JOIN customers c ON c.id = o."customerId"
          ${whereSql}
          ORDER BY ${sortSql} ${dirSql}, ${tiebreakerColSql}
          LIMIT ${pageSize} OFFSET ${offset}`
      : textSearch?.needsCustomerJoin && sort !== "customer"
      ? Prisma.sql`
          WITH candidates AS (
            SELECT id, sortkey, placed_at FROM (
              SELECT o.id AS id, ${sortSql} AS sortkey, o."placedAt" AS placed_at
              FROM orders o
              JOIN customers c ON c.id = o."customerId"
              WHERE (c."firstName" || ' ' || c."lastName") ILIKE ${textSearch.pattern}
              ${andFilterSql}
              ORDER BY ${sortSql} ${dirSql}, ${tiebreakerColSql}
              LIMIT ${candidateLimit}
            ) customer_candidates
            ${noteCandidates}
          )
          SELECT id FROM candidates
          ORDER BY sortkey ${dirSql}, ${tiebreakerAliasSql}
          LIMIT ${pageSize} OFFSET ${offset}`
      : useWalk
      ? Prisma.sql`
          SELECT o.id
          FROM orders o ${baseJoin}
          ${whereSql}
          ORDER BY ${sortSql} ${dirSql}, ${tiebreakerColSql}
          LIMIT ${pageSize} OFFSET ${offset}`
      : Prisma.sql`
          WITH m AS MATERIALIZED (
            SELECT o.id AS id, ${sortSql} AS sortkey, o."placedAt" AS placed_at
            FROM orders o ${baseJoin}
            ${whereSql}
          )
          SELECT id FROM m ORDER BY sortkey ${dirSql}, ${tiebreakerAliasSql}
          LIMIT ${pageSize} OFFSET ${offset}`;

    const cacheKey = buildCountCacheKey(q, filters);
    const countPromise =
      q && textSearch?.needsCustomerJoin
        ? tokenOrderSummaryCount(q, filters).then((count) =>
            count !== null ? count : cachedCount(cacheKey, () => exactBroadTextCount(q, filterConds)),
          )
        : cachedCount(cacheKey, () => exactCount(filterWhereJoin, whereSql));

    const [idRows, counted] = await Promise.all([
      prisma.$queryRaw<{ id: number }[]>(pageQuery),
      countPromise,
    ]);

    const approximate = false;
    const total = counted;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const data = await hydrateOrders(idRows.map((r) => r.id));

    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate };
    if (input.facets) result.facets = await computeFacets(filterWhereJoin, whereSql);
    return result;
  } catch (err) {
    mapDbError(err, "listOrders");
  }
}

function buildCountCacheKey(q: string | undefined, filters: ResolvedFilters): string {
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

async function cachedCount(cacheKey: string, compute: () => Promise<number>): Promise<number> {
  try {
    const hit = await prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT total FROM count_cache
      WHERE cache_key = ${cacheKey}
        AND cached_at > NOW() - INTERVAL '10 minutes'
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

/** exact count for pagination bounds; page fetching stays separately optimized. */
async function exactCount(join: Prisma.Sql, whereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count
    FROM orders o ${join} ${whereSql}`);
  return Number(rows[0]?.count ?? 0);
}

async function tokenOrderSummaryCount(
  q: string,
  filters: ResolvedFilters,
): Promise<number | null> {
  if (filters.minTotal !== null || filters.maxTotal !== null) return null;

  const token = searchToken(q);
  if (!token) return null;

  const probe = await getTextProbe(q);
  if (!probe.tokenOrderReady) return null;

  const conds: Prisma.Sql[] = [Prisma.sql`token = ${token}`];
  if (filters.from) conds.push(Prisma.sql`date >= ${filters.from}::date`);
  if (filters.to) conds.push(Prisma.sql`date <= ${filters.to}::date`);
  if (filters.statuses.length) {
    conds.push(Prisma.sql`status = ANY(${filters.statuses}::text[]::"OrderStatus"[])`);
  }
  if (filters.regionIds !== null) {
    conds.push(Prisma.sql`"regionId" = ANY(${filters.regionIds})`);
  }

  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT coalesce(sum("totalOrders"), 0)::bigint AS count
    FROM daily_customer_token_order_summary
    WHERE ${Prisma.join(conds, " AND ")}`);
  const tokenCount = Number(rows[0]?.count ?? 0);
  if (!probe.notesHaveMatches) return tokenCount;

  const filterConds = buildFilterConditions(filters);
  const andFilters = filterConds.length
    ? Prisma.sql`AND ${Prisma.join(filterConds, " AND ")}`
    : Prisma.empty;
  const noteRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count
    FROM orders o
    JOIN customers c ON c.id = o."customerId"
    WHERE o.notes ILIKE ${probe.pattern}
      AND NOT (
        lower(c."firstName") = ${token}
        OR lower(c."lastName") = ${token}
      )
      ${andFilters}`);
  return tokenCount + Number(noteRows[0]?.count ?? 0);
}

async function exactBroadTextCount(q: string, filterConds: Prisma.Sql[]): Promise<number> {
  const pattern = `%${escapeLike(q)}%`;
  const custRows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM customers
    WHERE ("firstName" || ' ' || "lastName") ILIKE ${pattern}`);
  const customerIds = custRows.map((r) => r.id);
  const andFilters = filterConds.length
    ? Prisma.sql`AND ${Prisma.join(filterConds, " AND ")}`
    : Prisma.empty;
  const customerMatches = customerIds.length
    ? Prisma.sql`
        SELECT o.id
        FROM unnest(${customerIds}::int[]) AS matched_customer(id)
        JOIN orders o ON o."customerId" = matched_customer.id
        ${andFilters}`
    : Prisma.sql`SELECT id FROM orders WHERE false`;
  const noteMatches =
    q.length >= 3
      ? Prisma.sql`
          UNION
          SELECT o.id
          FROM orders o
          WHERE o.notes ILIKE ${pattern}
          ${andFilters}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count
    FROM (
      ${customerMatches}
      ${noteMatches}
    ) matches`);
  return Number(rows[0]?.count ?? 0);
}

/** count(*) over the filter, bounded by COUNT_CAP + 1 so it never scans millions. */
async function cappedCount(join: Prisma.Sql, whereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count FROM (
      SELECT 1 FROM orders o ${join} ${whereSql} LIMIT ${COUNT_CAP + 1}
    ) capped`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Sidebar facet counts (per status, per region) for the current filter set.
 * Bounded by FACET_CAP rows; `approximate` is set when the set is larger.
 */
async function computeFacets(join: Prisma.Sql, whereSql: Prisma.Sql): Promise<OrderFacets> {
  const rows = await prisma.$queryRaw<{ dim: string; key: string | null; n: bigint }[]>(Prisma.sql`
    WITH base AS (
      SELECT o.status, o."regionId" FROM orders o ${join} ${whereSql} LIMIT ${FACET_CAP + 1}
    )
    SELECT 'status' AS dim, status::text AS key, count(*)::bigint AS n FROM base GROUP BY status
    UNION ALL
    SELECT 'region' AS dim, "regionId"::text AS key, count(*)::bigint AS n FROM base GROUP BY "regionId"`);

  const status: FacetCount[] = [];
  const regionCount = new Map<number, number>();
  let baseSize = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (r.dim === "status") {
      status.push({ value: r.key ?? "UNKNOWN", count: n });
      baseSize += n; // every order has a status, so this sums to |base|
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
  return { status, region, approximate: baseSize > FACET_CAP };
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
        WHERE cache_key = ${key} AND cached_at > NOW() - INTERVAL '10 minutes'
        LIMIT 1`).catch(() => [] as { total: bigint }[]);
      if (hit.length > 0) continue;
      const pattern = `%${token}%`;
      const custRows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM customers
        WHERE ("firstName" || ' ' || "lastName") ILIKE ${pattern}`).catch(() => [] as { id: number }[]);
      if (!custRows.length) continue;
      const ids = custRows.map((r) => r.id);
      const result = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM orders WHERE "customerId" = ANY(${ids}::int[])`
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
    const created = await prisma.order.create({
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
    clearTextProbeCaches();
    await updateOrderCategoryFacts(created.id);

    publishOrderEvent({
      id: created.id,
      total: Number(created.total),
      customerId: created.customerId,
      placedAt: created.placedAt.toISOString(),
      categorySlug,
    }).catch(() => {});
    updateDailySummary(created.id).catch(() => {});
    updateDailyCustomerCategorySummary(created.id).catch(() => {});
    updateDailyFilterCategorySummary(created.id).catch(() => {});
    updateDailyStatusCategorySummary(created.id).catch(() => {});
    updateDailyCustomerTokenCategorySummary(created.id).catch(() => {});
    updateDailyCustomerTokenCategoryRollup(created.id).catch(() => {});
    updateDailyCustomerTokenOrderSummary(created.id).catch(() => {});
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
