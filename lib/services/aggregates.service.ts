import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";
import {
  buildFilterConditions,
  buildSearchTextConditions,
  escapeLike,
  normalizeStatusList,
  resolveFilters,
  todayDateString,
} from "./orders.service";

const DEFAULT_TOP_CATEGORIES = 5;
const OTHER_BUCKET = "Others";

/** Lets the 7 updateXxx functions below run either against the module-level
 *  singleton (unused today — they're only called from the outbox worker) or
 *  inside a caller's interactive transaction, so a worker can run all 7 for
 *  one order atomically with marking the outbox event processed. */
type Db = typeof prisma | Prisma.TransactionClient;

interface AggRow {
  day: string;
  category: string;
  total_orders: bigint;
  total_items: bigint;
  total_revenue: Prisma.Decimal | string | number | null;
}

function canUseDailySummary(input: AggregateQueryInput): boolean {
  const noQ = !input.q || input.q.trim() === "";
  const noStatus = !input.status || input.status.trim() === "";
  const noMinTotal = input.minTotal == null;
  const noMaxTotal = input.maxTotal == null;
  return noQ && noStatus && noMinTotal && noMaxTotal;
}

function parseCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function searchToken(q: string | null | undefined): string | null {
  const token = q?.trim().toLowerCase();
  return token && /^[a-z0-9._@-]+$/.test(token) ? token : null;
}

function isMultiToken(q: string | null | undefined): boolean {
  const text = q?.trim();
  return Boolean(text && /\s/.test(text));
}

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  const query = {
    ...input,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  if (!query.from || !query.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  const topN =
    query.topCategories != null && query.topCategories > 0
      ? Math.trunc(query.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  try {
    const rows = canUseDailySummary(query)
      ? await fastPath(query)
      : (await customerTokenSummaryPath(query)) ??
        (await customerMultiTokenSummaryPath(query)) ??
        (await filterSummaryPath(query)) ??
        (await factFilterPath(query)) ??
        (await slowPath(query));
    return rowsToDailyAggregates(rows, topN);
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

/** Single-token `q`: rollup/summary tables first, `slowPath` (search_text) if empty. */
async function customerTokenSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  if (input.minTotal != null || input.maxTotal != null) return null;
  const token = searchToken(input.q);
  if (!token) return null;

  const status = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);

  if (status.length === 0 && regionCodes.length === 0) {
    return customerTokenRollupPath(input, token);
  }

  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.token = ${token}`,
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
  ];
  if (status.length) conds.push(Prisma.sql`ds.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`ds."regionCode" = ANY(${regionCodes})`);

  const rows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD') AS day,
      ds."categoryName"              AS category,
      SUM(ds."totalOrders")::bigint  AS total_orders,
      SUM(ds."totalItems")::bigint   AS total_items,
      SUM(ds."totalRevenue")         AS total_revenue
    FROM daily_customer_token_category_summary ds
    WHERE ${Prisma.join(conds, " AND ")}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);

  return rows.length > 0 ? rows : null; // empty -> fall through to slowPath
}

async function customerTokenRollupPath(
  input: AggregateQueryInput,
  token: string,
): Promise<AggRow[] | null> {
  const topN =
    input.topCategories != null && input.topCategories > 0
      ? Math.trunc(input.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  const rows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH grouped AS (
      SELECT
        ds.date                       AS date,
        ds."categoryName"             AS category,
        SUM(ds."totalOrders")::bigint AS total_orders,
        SUM(ds."totalItems")::bigint  AS total_items,
        SUM(ds."totalRevenue")        AS total_revenue
      FROM daily_customer_token_category_rollup ds
      WHERE ds.token = ${token}
        AND ds.date >= ${input.from}::date
        AND ds.date <= ${input.to}::date
      GROUP BY ds.date, ds."categoryName"
    ),
    ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY date ORDER BY total_revenue DESC, category ASC
      ) AS rn
      FROM grouped
    ),
    bucketed AS (
      SELECT
        date,
        CASE WHEN rn <= ${topN} THEN category ELSE ${OTHER_BUCKET} END AS category,
        total_orders, total_items, total_revenue
      FROM ranked
    )
    SELECT
      to_char(date, 'YYYY-MM-DD') AS day,
      category,
      SUM(total_orders)::bigint AS total_orders,
      SUM(total_items)::bigint  AS total_items,
      SUM(total_revenue)        AS total_revenue
    FROM bucketed
    GROUP BY date, category
    ORDER BY date ASC, category ASC`);

  return rows.length > 0 ? rows : null; // empty -> fall through to slowPath
}

/** Multi-word `q` (no total filter): customers matched by name via a CTE,
 *  joined against the daily customer-category summary. Ports GCP's
 *  queryMultiTokenViaCte. Falls through to slowPath if empty. */
async function customerMultiTokenSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const q = input.q?.trim();
  if (!q || !isMultiToken(q) || input.minTotal != null || input.maxTotal != null) return null;

  const tokens = q.split(/\s+/).filter(Boolean);
  const tokenConds = tokens.map(
    (t) => Prisma.sql`("firstName" || ' ' || "lastName") ILIKE ${`%${escapeLike(t)}%`}`,
  );

  const status = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);
  const conds: Prisma.Sql[] = [
    Prisma.sql`dcs."customerId" IN (SELECT id FROM matching_customers)`,
    Prisma.sql`dcs.date >= ${input.from}::date`,
    Prisma.sql`dcs.date <= ${input.to}::date`,
  ];
  if (status.length) conds.push(Prisma.sql`dcs.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`dcs."regionCode" = ANY(${regionCodes})`);

  const rows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH matching_customers AS (
      SELECT id FROM customers WHERE ${Prisma.join(tokenConds, " AND ")}
    )
    SELECT
      to_char(dcs.date, 'YYYY-MM-DD') AS day,
      dcs."categoryName"              AS category,
      SUM(dcs."totalOrders")::bigint  AS total_orders,
      SUM(dcs."totalItems")::bigint   AS total_items,
      SUM(dcs."totalRevenue")         AS total_revenue
    FROM daily_customer_category_summary dcs
    WHERE ${Prisma.join(conds, " AND ")}
    GROUP BY dcs.date, dcs."categoryName"
    ORDER BY dcs.date ASC, dcs."categoryName" ASC`);

  return rows.length > 0 ? rows : null; // empty -> fall through to slowPath
}

async function filterSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const noQ = !input.q || input.q.trim() === "";
  if (!noQ || input.minTotal != null || input.maxTotal != null) return null;

  const status = normalizeStatusList(input.status);
  if (status.length === 0) return null;

  const regionCodes = parseCsv(input.regionCode);
  if (regionCodes.length === 0) {
    return prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT
        to_char(ds.date, 'YYYY-MM-DD') AS day,
        ds."categoryName"              AS category,
        SUM(ds."totalOrders")::bigint  AS total_orders,
        SUM(ds."totalItems")::bigint   AS total_items,
        SUM(ds."totalRevenue")         AS total_revenue
      FROM daily_status_category_summary ds
      WHERE ds.date >= ${input.from}::date
        AND ds.date <= ${input.to}::date
        AND ds.status = ANY(${status}::text[]::"OrderStatus"[])
      GROUP BY ds.date, ds."categoryName"
      ORDER BY ds.date ASC, ds."categoryName" ASC`);
  }

  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
    Prisma.sql`ds.status = ANY(${status}::text[]::"OrderStatus"[])`,
  ];
  if (regionCodes.length) {
    conds.push(Prisma.sql`ds."regionCode" = ANY(${regionCodes})`);
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD') AS day,
      ds."categoryName"              AS category,
      SUM(ds."totalOrders")::bigint  AS total_orders,
      SUM(ds."totalItems")::bigint   AS total_items,
      SUM(ds."totalRevenue")         AS total_revenue
    FROM daily_filter_category_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
}

async function factFilterPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const noQ = !input.q || input.q.trim() === "";
  if (!noQ) return null;
  const hasTotalFilter = input.minTotal != null || input.maxTotal != null;
  if (!hasTotalFilter) return null;

  const status = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);
  const conds: Prisma.Sql[] = [
    Prisma.sql`f.date >= ${input.from}::date`,
    Prisma.sql`f.date <= ${input.to}::date`,
  ];
  if (status.length) conds.push(Prisma.sql`f.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`f."regionCode" = ANY(${regionCodes})`);
  if (input.minTotal != null) conds.push(Prisma.sql`f."orderTotal" >= ${input.minTotal}`);
  if (input.maxTotal != null) conds.push(Prisma.sql`f."orderTotal" <= ${input.maxTotal}`);

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(f.date, 'YYYY-MM-DD')           AS day,
      f."categoryName"                        AS category,
      count(*)::bigint                        AS total_orders,
      coalesce(sum(f."totalItems"), 0)::bigint AS total_items,
      coalesce(sum(f."totalRevenue"), 0)       AS total_revenue
    FROM order_category_facts f
    ${whereSql}
    GROUP BY f.date, f."categoryName"
    ORDER BY f.date ASC, f."categoryName" ASC`);
}

async function fastPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
  ];

  if (input.regionCode) {
    const codes = input.regionCode
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (codes.length) {
      conds.push(Prisma.sql`ds."regionCode" = ANY(${codes})`);
    }
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD')    AS day,
      ds."categoryName"                  AS category,
      SUM(ds."totalOrders")::bigint      AS total_orders,
      SUM(ds."totalItems")::bigint       AS total_items,
      SUM(ds."totalRevenue")             AS total_revenue
    FROM daily_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
}

/** Catch-all: filters orders directly by search_text, joined straight into the
 *  category aggregation. Ports GCP's queryViaSearchText. */
async function slowPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const filters = await resolveFilters(input);
  const conds = [...buildSearchTextConditions(input.q), ...buildFilterConditions(filters)];
  const whereSql = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(o."placedAt"::date, 'YYYY-MM-DD')                          AS day,
      cat.name                                                            AS category,
      count(DISTINCT o.id)::bigint                                        AS total_orders,
      coalesce(sum(oi.quantity), 0)::bigint                               AS total_items,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0)  AS total_revenue
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    ${whereSql}
    GROUP BY day, cat.name
    ORDER BY day ASC, cat.name ASC`);
}

function rowsToDailyAggregates(rows: AggRow[], topN: number): DailyAggregate[] {
  const byDate = new Map<string, DailyAggregate>();
  for (const r of rows) {
    let entry = byDate.get(r.day);
    if (!entry) {
      entry = {
        date: r.day,
        categories: {},
        totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 },
      };
      byDate.set(r.day, entry);
    }

    const totalOrders = Number(r.total_orders);
    const totalRevenue = Number(r.total_revenue ?? 0);
    const totalItems = Number(r.total_items);
    const existing = entry.categories[r.category];
    const cat: CategoryAggregate = existing
      ? {
          totalOrders: existing.totalOrders + totalOrders,
          totalRevenue: existing.totalRevenue + totalRevenue,
          totalItems: existing.totalItems + totalItems,
          avgOrderValue: 0,
        }
      : {
          totalOrders,
          totalRevenue,
          totalItems,
          avgOrderValue: 0,
        };
    cat.avgOrderValue = cat.totalOrders > 0 ? cat.totalRevenue / cat.totalOrders : 0;
    entry.categories[r.category] = cat;
    entry.totals.totalOrders += totalOrders;
    entry.totals.totalRevenue += totalRevenue;
    entry.totals.totalItems += totalItems;
  }

  return Array.from(byDate.values()).map((day) => capToTopCategories(day, topN));
}

function capToTopCategories(day: DailyAggregate, topN: number): DailyAggregate {
  const entries = Object.entries(day.categories);
  if (entries.length <= topN) return day;

  const existingOther = day.categories[OTHER_BUCKET];
  const realEntries = entries
    .filter(([category]) => category !== OTHER_BUCKET)
    .sort(
    ([, a], [, b]) => b.totalRevenue - a.totalRevenue,
    );

  const top = realEntries.slice(0, topN);
  const rest = realEntries.slice(topN);

  const other = rest.reduce<CategoryAggregate>(
    (acc, [, c]) => ({
      totalOrders: acc.totalOrders + c.totalOrders,
      totalRevenue: acc.totalRevenue + c.totalRevenue,
      totalItems: acc.totalItems + c.totalItems,
      avgOrderValue: 0,
    }),
    existingOther ?? { totalOrders: 0, totalRevenue: 0, totalItems: 0, avgOrderValue: 0 },
  );
  other.avgOrderValue = other.totalOrders > 0 ? other.totalRevenue / other.totalOrders : 0;

  const categories: Record<string, CategoryAggregate> = Object.fromEntries(top);
  if (other.totalOrders > 0 || existingOther) {
    categories[OTHER_BUCKET] = other;
  }
  return { ...day, categories };
}

/**
 * Incrementally upsert daily_summary rows for a single order. Fire-and-forget
 * from createOrder so the summary stays in sync without a full backfill.
 */
export async function updateDailySummary(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO daily_summary (date, "categoryId", "categoryName", "regionId", "regionCode",
                               "totalOrders", "totalRevenue", "totalItems", "avgOrderValue",
                               "createdAt", "updatedAt")
    SELECT
      o."placedAt"::date,
      cat.id,
      cat.name,
      o."regionId",
      r.code,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, cat.id, cat.name, o."regionId", r.code
    ON CONFLICT (date, "categoryId", "regionId")
    DO UPDATE SET
      "totalOrders"  = daily_summary."totalOrders" + 1,
      "totalRevenue" = daily_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_summary."totalItems" + EXCLUDED."totalItems",
      "avgOrderValue"= (daily_summary."totalRevenue" + EXCLUDED."totalRevenue")
                       / (daily_summary."totalOrders" + 1),
      "updatedAt"    = now()`);
}

export async function updateOrderCategoryFacts(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO order_category_facts (
      "orderId", "placedAt", date, "regionId", "regionCode", status, "orderTotal",
      "categoryId", "categoryName", "totalItems", "totalRevenue"
    )
    SELECT
      o.id,
      o."placedAt",
      o."placedAt"::date,
      o."regionId",
      r.code,
      o.status,
      o.total,
      cat.id,
      cat.name,
      coalesce(sum(oi.quantity), 0)::int,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0)
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o.id, o."placedAt", o."regionId", r.code, o.status, o.total, cat.id, cat.name
    ON CONFLICT ("orderId", "categoryId")
    DO UPDATE SET
      "placedAt" = EXCLUDED."placedAt",
      date = EXCLUDED.date,
      "regionId" = EXCLUDED."regionId",
      "regionCode" = EXCLUDED."regionCode",
      status = EXCLUDED.status,
      "orderTotal" = EXCLUDED."orderTotal",
      "categoryName" = EXCLUDED."categoryName",
      "totalItems" = EXCLUDED."totalItems",
      "totalRevenue" = EXCLUDED."totalRevenue"`);
}

export async function updateDailyCustomerCategorySummary(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_category_summary (
      date, "customerId", "regionId", "regionCode", status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      o."customerId",
      o."regionId",
      r.code,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, o."customerId", o."regionId", r.code, o.status, cat.id, cat.name
    ON CONFLICT (date, "customerId", "regionId", status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_customer_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_customer_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyFilterCategorySummary(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO daily_filter_category_summary (
      date, "regionId", "regionCode", status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      o."regionId",
      r.code,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, o."regionId", r.code, o.status, cat.id, cat.name
    ON CONFLICT (date, "regionId", status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_filter_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_filter_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_filter_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyStatusCategorySummary(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO daily_status_category_summary (
      date, status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, o.status, cat.id, cat.name
    ON CONFLICT (date, status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_status_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_status_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_status_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyCustomerTokenCategorySummary(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_token_category_summary (
      date, token, "regionId", "regionCode", status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      t.token,
      o."regionId",
      r.code,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN customers c   ON c.id = o."customerId"
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    CROSS JOIN LATERAL (
      SELECT DISTINCT token
      FROM unnest(ARRAY[
        lower(c."firstName"),
        lower(c."lastName"),
        lower(c.email),
        lower(split_part(c.email, '@', 1))
      ]) AS token
      WHERE token <> ''
    ) t
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, t.token, o."regionId", r.code, o.status, cat.id, cat.name
    ON CONFLICT (date, token, "regionId", status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_customer_token_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_token_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_customer_token_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyCustomerTokenCategoryRollup(orderId: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_token_category_rollup (
      date, token, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      t.token,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN customers c    ON c.id = o."customerId"
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    CROSS JOIN LATERAL (
      SELECT DISTINCT token
      FROM unnest(ARRAY[
        lower(c."firstName"),
        lower(c."lastName"),
        lower(c.email),
        lower(split_part(c.email, '@', 1))
      ]) AS token
      WHERE token <> ''
    ) t
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, t.token, cat.id, cat.name
    ON CONFLICT (date, token, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_customer_token_category_rollup."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_token_category_rollup."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_customer_token_category_rollup."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

