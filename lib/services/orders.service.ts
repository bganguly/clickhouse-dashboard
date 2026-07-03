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
    const dirSql = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
    const tiebreakerColSql =
      sort === "placedAt"
        ? Prisma.raw(`o.id ${dir === "asc" ? "ASC" : "DESC"}`)
        : Prisma.raw('o."placedAt" DESC, o.id DESC');

    const pageQuery = Prisma.sql`
      SELECT o.id
      FROM orders o ${customerJoin}
      ${whereSql}
      ORDER BY ${sortSql} ${dirSql}, ${tiebreakerColSql}
      LIMIT ${pageSize} OFFSET ${offset}`;

    const cacheKey = buildCountCacheKey(q, filters);
    const [idRows, total] = await Promise.all([
      prisma.$queryRaw<{ id: number }[]>(pageQuery),
      cachedCount(cacheKey, () => exactCount(whereSql)),
    ]);

    const data = await hydrateOrders(idRows.map((r) => r.id));
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate: false };
    if (input.facets) result.facets = await computeFacets(whereSql);
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

/** Exact-count cache, keyed by the full filter signature. 30-day TTL, fail-open
 *  (a cache read/write failure never breaks a search — it just recomputes). */
async function cachedCount(cacheKey: string, compute: () => Promise<number>): Promise<number> {
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
async function exactCount(whereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count
    FROM orders o ${whereSql}`);
  return Number(rows[0]?.count ?? 0);
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
