import { query } from "@/lib/clickhouse";
import type { ClickHouseSettings } from "@clickhouse/client";
import { AppError, mapDbError } from "@/lib/errors";
import { aggCacheGet, aggCacheSet } from "@/lib/aggregates-cache";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";
import {
  escapeLike,
  normalizeStatusList,
  resolveFilters,
  todayDateString,
  isPureDateRangeQuery,
  getOrderCount,
} from "./orders.service";

const DEFAULT_TOP_CATEGORIES = 5;
const OTHER_BUCKET = "Others";

const AGG_CACHE: ClickHouseSettings = {
  use_query_cache: 1,
  query_cache_ttl: 60,
  query_cache_share_between_users: 1,
};

interface AggRow {
  day: string;
  category: string;
  total_orders: string;
  total_items: string;
  total_revenue: string;
}

function parseCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function isMultiToken(q: string | null | undefined): boolean {
  const text = q?.trim();
  return Boolean(text && /\s/.test(text));
}

function canUseDailySummary(input: AggregateQueryInput): boolean {
  return (
    (!input.q || input.q.trim() === "") &&
    (!input.status || input.status.trim() === "") &&
    input.minTotal == null &&
    input.maxTotal == null
  );
}

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  const query_in = {
    ...input,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  if (!query_in.from || !query_in.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  const topN =
    query_in.topCategories != null && query_in.topCategories > 0
      ? Math.trunc(query_in.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  const cacheKey = `data:${JSON.stringify(query_in)}`;
  const cached = await aggCacheGet<DailyAggregate[]>(cacheKey);
  if (cached) return cached;

  try {
    const t0 = Date.now();
    let aggPath = "fastPath";
    let rows: AggRow[];
    if (canUseDailySummary(query_in)) {
      rows = await fastPath(query_in);
    } else {
      const r1 = await customerMultiTokenSummaryPath(query_in);
      if (r1) { aggPath = "customerMultiToken"; rows = r1; }
      else {
        const r2 = await filterSummaryPath(query_in);
        if (r2) { aggPath = "filterSummary"; rows = r2; }
        else {
          const r3 = await factFilterPath(query_in);
          if (r3) { aggPath = "factFilter"; rows = r3; }
          else {
            const r4 = await tokenSummaryPath(query_in);
            if (r4) { aggPath = "tokenSummary"; rows = r4; }
            else {
              const r5 = await searchFactPath(query_in);
              if (r5) { aggPath = "searchFact"; rows = r5; }
              else { aggPath = "slowPath"; rows = await slowPath(query_in); }
            }
          }
        }
      }
    }
    console.log(`[agg] path=${aggPath} ms=${Date.now() - t0} from=${query_in.from} to=${query_in.to} q=${query_in.q ?? ""}`);

    const result = rowsToDailyAggregates(rows, topN);
    await aggCacheSet(cacheKey, result);
    return result;
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

export async function getExactAggregateTotal(input: AggregateQueryInput): Promise<number> {
  const query_in = {
    ...input,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  const inProcKey = `total:${JSON.stringify(query_in)}`;
  const cachedTotal = await aggCacheGet<number>(inProcKey);
  if (cachedTotal != null) return cachedTotal;

  try {
    const filters = await resolveFilters(query_in);
    const total = await getOrderCount(query_in.q ?? undefined, filters);
    await aggCacheSet(inProcKey, total);
    return total;
  } catch (err) {
    mapDbError(err, "getExactAggregateTotal");
  }
}

async function fastPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const clauses = [
    `date >= {from: Date}`,
    `date <= {to: Date}`,
  ];
  const params: Record<string, unknown> = { from: input.from, to: input.to };
  const regionCodes = parseCsv(input.regionCode);
  if (regionCodes.length) {
    clauses.push(`regionCode IN ({regionCodes: Array(String)})`);
    params["regionCodes"] = regionCodes;
  }
  return query<AggRow>(
    `SELECT
       toString(date)       AS day,
       categoryName         AS category,
       sum(totalOrders)     AS total_orders,
       sum(totalItems)      AS total_items,
       sum(totalRevenue)    AS total_revenue
     FROM daily_summary
     WHERE ${clauses.join(" AND ")}
     GROUP BY date, categoryName
     ORDER BY date ASC, categoryName ASC`,
    params,
    AGG_CACHE,
  );
}

async function filterSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const noQ = !input.q || input.q.trim() === "";
  if (!noQ || input.minTotal != null || input.maxTotal != null) return null;

  const statuses = normalizeStatusList(input.status);
  if (statuses.length === 0) return null;

  const regionCodes = parseCsv(input.regionCode);
  const params: Record<string, unknown> = { from: input.from, to: input.to, statuses };

  if (regionCodes.length === 0) {
    return query<AggRow>(
      `SELECT
         toString(date)    AS day,
         categoryName      AS category,
         sum(totalOrders)  AS total_orders,
         sum(totalItems)   AS total_items,
         sum(totalRevenue) AS total_revenue
       FROM daily_status_category_summary
       WHERE date >= {from: Date} AND date <= {to: Date}
         AND status IN ({statuses: Array(String)})
       GROUP BY date, categoryName
       ORDER BY date ASC, categoryName ASC`,
      params,
      AGG_CACHE,
    );
  }

  params["regionCodes"] = regionCodes;
  return query<AggRow>(
    `SELECT
       toString(date)    AS day,
       categoryName      AS category,
       sum(totalOrders)  AS total_orders,
       sum(totalItems)   AS total_items,
       sum(totalRevenue) AS total_revenue
     FROM daily_filter_category_summary
     WHERE date >= {from: Date} AND date <= {to: Date}
       AND status IN ({statuses: Array(String)})
       AND regionCode IN ({regionCodes: Array(String)})
     GROUP BY date, categoryName
     ORDER BY date ASC, categoryName ASC`,
    params,
    AGG_CACHE,
  );
}

async function factFilterPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const noQ = !input.q || input.q.trim() === "";
  if (!noQ) return null;
  const hasTotalFilter = input.minTotal != null || input.maxTotal != null;
  if (!hasTotalFilter) return null;

  const clauses = [`date >= {from: Date}`, `date <= {to: Date}`];
  const params: Record<string, unknown> = { from: input.from, to: input.to };
  const statuses = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);
  if (statuses.length) { clauses.push(`status IN ({statuses: Array(String)})`); params["statuses"] = statuses; }
  if (regionCodes.length) { clauses.push(`regionCode IN ({regionCodes: Array(String)})`); params["regionCodes"] = regionCodes; }
  if (input.minTotal != null) { clauses.push(`orderTotal >= {minTotal: Float64}`); params["minTotal"] = input.minTotal; }
  if (input.maxTotal != null) { clauses.push(`orderTotal <= {maxTotal: Float64}`); params["maxTotal"] = input.maxTotal; }

  return query<AggRow>(
    `SELECT
       toString(date)  AS day,
       categoryName    AS category,
       count()         AS total_orders,
       sum(totalItems) AS total_items,
       sum(totalRevenue) AS total_revenue
     FROM order_category_facts
     WHERE ${clauses.join(" AND ")}
     GROUP BY date, categoryName
     ORDER BY date ASC, categoryName ASC`,
    params,
    AGG_CACHE,
  );
}

async function customerMultiTokenSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const q = input.q?.trim();
  if (!q || !isMultiToken(q) || input.minTotal != null || input.maxTotal != null) return null;

  const tokens = q.split(/\s+/).filter(Boolean);
  const tokenClauses = tokens
    .map((_, i) => `positionCaseInsensitive(firstName || ' ' || lastName, {tok${i}: String}) > 0`)
    .join(" AND ");
  const tokenParams: Record<string, unknown> = {};
  tokens.forEach((t, i) => { tokenParams[`tok${i}`] = escapeLike(t); });

  const statuses = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);
  const aggClauses = [`date >= {from: Date}`, `date <= {to: Date}`];
  const aggParams: Record<string, unknown> = { from: input.from, to: input.to, ...tokenParams };
  if (statuses.length) { aggClauses.push(`status IN ({statuses: Array(String)})`); aggParams["statuses"] = statuses; }
  if (regionCodes.length) { aggClauses.push(`regionCode IN ({regionCodes: Array(String)})`); aggParams["regionCodes"] = regionCodes; }

  const rows = await query<AggRow>(
    `SELECT
       toString(date)    AS day,
       categoryName      AS category,
       sum(totalOrders)  AS total_orders,
       sum(totalItems)   AS total_items,
       sum(totalRevenue) AS total_revenue
     FROM daily_customer_category_summary
     WHERE customerId IN (
       SELECT customerId FROM customers WHERE ${tokenClauses}
     )
     AND ${aggClauses.join(" AND ")}
     GROUP BY date, categoryName
     ORDER BY date ASC, categoryName ASC`,
    aggParams,
    AGG_CACHE,
  );

  return rows.length > 0 ? rows : null;
}

async function tokenSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const q = input.q?.trim();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  if (input.minTotal != null || input.maxTotal != null) return null;
  if (normalizeStatusList(input.status).length) return null;
  if (parseCsv(input.regionCode).length) return null;

  const rows = await query<AggRow>(
    `SELECT
       toString(date)   AS day,
       categoryName     AS category,
       sum(orderCount)  AS total_orders,
       0                AS total_items,
       sum(orderTotal)  AS total_revenue
     FROM daily_search_token_summary
     WHERE token = {tok: String}
       AND date >= {from: Date}
       AND date <= {to: Date}
     GROUP BY date, categoryName
     ORDER BY date ASC, categoryName ASC`,
    { tok: tokens[0].toLowerCase(), from: input.from, to: input.to },
    AGG_CACHE,
  );
  return rows.length > 0 ? rows : null;
}

async function searchFactPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const q = input.q?.trim();
  if (!q) return null;

  const tokens = q.split(/\s+/).filter(Boolean);
  const clauses = [`date >= {from: Date}`, `date <= {to: Date}`];
  const params: Record<string, unknown> = { from: input.from, to: input.to };

  let pi = 0;
  for (const tok of tokens) {
    const k = `stok${pi++}`;
    clauses.push(`hasToken(searchText, {${k}: String})`);
    params[k] = tok.toLowerCase();
  }

  const statuses = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);
  if (statuses.length) { clauses.push(`status IN ({statuses: Array(String)})`); params["statuses"] = statuses; }
  if (regionCodes.length) { clauses.push(`regionCode IN ({regionCodes: Array(String)})`); params["regionCodes"] = regionCodes; }
  if (input.minTotal != null) { clauses.push(`orderTotal >= {minTotal: Float64}`); params["minTotal"] = input.minTotal; }
  if (input.maxTotal != null) { clauses.push(`orderTotal <= {maxTotal: Float64}`); params["maxTotal"] = input.maxTotal; }

  const rows = await query<AggRow>(
    `SELECT
       toString(date)    AS day,
       categoryName      AS category,
       count()           AS total_orders,
       sum(totalItems)   AS total_items,
       sum(totalRevenue) AS total_revenue
     FROM order_category_facts
     WHERE ${clauses.join(" AND ")}
     GROUP BY date, categoryName
     ORDER BY date ASC, categoryName ASC`,
    params,
    AGG_CACHE,
  );
  return rows.length > 0 ? rows : null;
}

async function slowPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);
  const filters = await resolveFilters(input);

  function buildSlowClauses(useLike: boolean) {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    let pi = 0;
    for (const tok of tokens) {
      const k = `stok${pi++}`;
      if (useLike) {
        clauses.push(`lower(searchText) LIKE {${k}: String}`);
        params[k] = `%${escapeLike(tok.toLowerCase())}%`;
      } else {
        clauses.push(`hasToken(searchText, {${k}: String})`);
        params[k] = tok.toLowerCase();
      }
    }
    if (filters.statuses.length) { clauses.push(`status IN ({statuses: Array(String)})`); params["statuses"] = filters.statuses; }
    if (filters.regionCodes.length) { clauses.push(`regionCode IN ({regionCodes: Array(String)})`); params["regionCodes"] = filters.regionCodes; }
    if (filters.from) { clauses.push(`placedAt >= {from: DateTime64(3)}`); params["from"] = filters.from; }
    if (filters.to) { clauses.push(`placedAt <= {to: DateTime64(3)}`); params["to"] = filters.to; }
    if (filters.minTotal !== null) { clauses.push(`total >= {minTotal: Float64}`); params["minTotal"] = filters.minTotal; }
    if (filters.maxTotal !== null) { clauses.push(`total <= {maxTotal: Float64}`); params["maxTotal"] = filters.maxTotal; }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  const SQL = (where: string) => `SELECT
       toString(toDate(placedAt))                                AS day,
       item.categoryName                                         AS category,
       count()                                                   AS total_orders,
       sum(item.unitPrice * item.quantity * (1 - item.discount)) AS total_revenue,
       sum(item.quantity)                                        AS total_items
     FROM orders
     ARRAY JOIN items AS item
     ${where}
     GROUP BY day, category
     ORDER BY day ASC, category ASC`;

  const { where, params } = buildSlowClauses(false);
  const rows = await query<AggRow>(SQL(where), params);
  if (rows.length > 0 || tokens.length === 0) return rows;

  const { where: whereLike, params: paramsLike } = buildSlowClauses(true);
  return query<AggRow>(SQL(whereLike), paramsLike);
}

function rowsToDailyAggregates(rows: AggRow[], topN: number): DailyAggregate[] {
  const byDate = new Map<string, DailyAggregate>();
  for (const r of rows) {
    let entry = byDate.get(r.day);
    if (!entry) {
      entry = { date: r.day, categories: {}, totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 } };
      byDate.set(r.day, entry);
    }
    const totalOrders = Number(r.total_orders);
    const totalRevenue = Number(r.total_revenue ?? 0);
    const totalItems = Number(r.total_items);
    const existing = entry.categories[r.category];
    const cat: CategoryAggregate = existing
      ? { totalOrders: existing.totalOrders + totalOrders, totalRevenue: existing.totalRevenue + totalRevenue, totalItems: existing.totalItems + totalItems, avgOrderValue: 0 }
      : { totalOrders, totalRevenue, totalItems, avgOrderValue: 0 };
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
  const realEntries = entries.filter(([cat]) => cat !== OTHER_BUCKET).sort(([, a], [, b]) => b.totalRevenue - a.totalRevenue);
  const top = realEntries.slice(0, topN);
  const rest = realEntries.slice(topN);
  const other = rest.reduce<CategoryAggregate>(
    (acc, [, c]) => ({ totalOrders: acc.totalOrders + c.totalOrders, totalRevenue: acc.totalRevenue + c.totalRevenue, totalItems: acc.totalItems + c.totalItems, avgOrderValue: 0 }),
    existingOther ?? { totalOrders: 0, totalRevenue: 0, totalItems: 0, avgOrderValue: 0 },
  );
  other.avgOrderValue = other.totalOrders > 0 ? other.totalRevenue / other.totalOrders : 0;
  const categories: Record<string, CategoryAggregate> = Object.fromEntries(top);
  if (other.totalOrders > 0 || existingOther) categories[OTHER_BUCKET] = other;
  return { ...day, categories };
}

void (process.env.CLICKHOUSE_URL && (async () => {
  try {
    const today = todayDateString();
    await Promise.all([
      getDailyAggregates({ from: "2020-01-01", to: today, q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: DEFAULT_TOP_CATEGORIES }),
      getExactAggregateTotal({ from: "2020-01-01", to: today, q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: DEFAULT_TOP_CATEGORIES }),
    ]);
  } catch {}
})());
