import { diag } from "@/lib/diag";
import { mapDbError } from "@/lib/errors";
import { aggCacheGet, aggCacheSet } from "@/lib/aggregates-cache";
import { singleFlight } from "@/lib/single-flight";
import type { AggregateQueryInput, DailyAggregate } from "@/lib/types";
import * as typesense from "@/lib/typesense";
import { resolveFilters, todayDateString } from "./orders.helpers";
import { listOrders, getOrderCount } from "./orders.service";
import {
  AGG_CACHE as _AGG_CACHE,
  canUseDailySummary,
  customerMultiTokenSummaryPath,
  factFilterPath,
  fastPath,
  filterSummaryPath,
  rowsToDailyAggregates,
  searchFactPath,
  slowPath,
  tokenSummaryPath,
} from "./aggregates.paths";

export const DATASET_START = "2024-07-17";
export const DATASET_END   = "2026-07-17";

export async function getDailyAggregates(input: AggregateQueryInput, _diag?: { src: string }): Promise<DailyAggregate[]> {
  const query_in = {
    ...input,
    q: input.q?.trim() || null,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  if (!query_in.from || !query_in.to) {
    const { AppError } = await import("@/lib/errors");
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  const DEFAULT_TOP_CATEGORIES = 5;
  const topN =
    query_in.topCategories != null && query_in.topCategories > 0
      ? Math.trunc(query_in.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  const { ...keyFields } = query_in;
  const cacheKey = `data:${JSON.stringify({ ...keyFields, topCategories: topN })}`;
  const _seriesT0 = Date.now();
  const _seriesSrc = { value: "ch" };
  const cached = await aggCacheGet<DailyAggregate[]>(cacheKey, _seriesSrc);
  const _seriesMs = Date.now() - _seriesT0;
  if (cached) {
    if (_diag) _diag.src = _seriesSrc.value;
    if (diag && query_in.q) console.log(`[agg-cache] q="${query_in.q}" → chart series HIT src=${_seriesSrc.value} ${_seriesSrc.value !== "mem" ? `redis=${_seriesMs}ms` : ""}`);
    else if (diag) console.log(`[agg-cache] base-case → chart series HIT src=${_seriesSrc.value} ${_seriesSrc.value !== "mem" ? `redis=${_seriesMs}ms` : ""}`);
    return cached;
  }
  if (_diag) _diag.src = "ch";
  if (diag && query_in.q) console.log(`[agg-cache] q="${query_in.q}" → chart series MISS redis=${_seriesMs}ms`);
  else if (diag) console.log(`[agg-cache] base-case → chart series MISS redis=${_seriesMs}ms`);

  return singleFlight(cacheKey, async () => {
    try {
      const t0 = Date.now();
      let aggPath = "fastPath";
      let rows;
      if (canUseDailySummary(query_in)) {
        rows = await fastPath(query_in, topN);
      } else {
        const rawQ = query_in.q?.trim() ?? "";
        const rawTokens = rawQ.split(/\s+/).filter(Boolean);
        const expandedTokens = rawTokens.length > 0 && typesense.isEnabled()
          ? await Promise.all(rawTokens.map((t) => typesense.expandPrefix(t)))
          : rawTokens;
        const expandedQ = expandedTokens.join(" ");
        const qin = expandedQ && expandedQ !== rawQ ? { ...query_in, q: expandedQ } : query_in;

        const r1 = await customerMultiTokenSummaryPath(qin);
        if (r1) { aggPath = "customerMultiToken"; rows = r1; }
        else {
          const r2 = await filterSummaryPath(qin);
          if (r2) { aggPath = "filterSummary"; rows = r2; }
          else {
            const r3 = await factFilterPath(qin);
            if (r3) { aggPath = "factFilter"; rows = r3; }
            else {
              const r4 = await tokenSummaryPath(qin);
              if (r4) { aggPath = "tokenSummary"; rows = r4; }
              else {
                const r5 = await searchFactPath(qin);
                if (r5) { aggPath = "searchFact"; rows = r5; }
                else { aggPath = "slowPath"; rows = await slowPath(qin); }
              }
            }
          }
        }
      }
      if (diag) console.log(`[agg] path=${aggPath} ms=${Date.now() - t0} from=${query_in.from} to=${query_in.to} q=${query_in.q ?? ""}`);

      const result = rowsToDailyAggregates(rows, topN);
      await aggCacheSet(cacheKey, result);
      return result;
    } catch (err) {
      mapDbError(err, "getDailyAggregates");
    }
  });
}

export async function getExactAggregateTotal(input: AggregateQueryInput, _diag?: { src: string }): Promise<number> {
  const query_in = {
    ...input,
    q: input.q?.trim() || null,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  const { topCategories: _tc, ...totalKeyFields } = query_in;
  const inProcKey = `total:${JSON.stringify(totalKeyFields)}`;
  const _totalT0 = Date.now();
  const _totalSrc = { value: "ch" };
  const cachedTotal = await aggCacheGet<number>(inProcKey, _totalSrc);
  const _totalMs = Date.now() - _totalT0;
  if (cachedTotal != null) {
    if (_diag) _diag.src = _totalSrc.value;
    if (diag && query_in.q) console.log(`[agg-cache] q="${query_in.q}" → chart total HIT src=${_totalSrc.value} ${_totalSrc.value !== "mem" ? `redis=${_totalMs}ms` : ""}`);
    else if (diag) console.log(`[agg-cache] base-case → chart total HIT src=${_totalSrc.value} ${_totalSrc.value !== "mem" ? `redis=${_totalMs}ms` : ""}`);
    return cachedTotal;
  }
  if (_diag) _diag.src = "ch";
  if (diag && query_in.q) console.log(`[agg-cache] q="${query_in.q}" → chart total MISS redis=${_totalMs}ms`);
  else if (diag) console.log(`[agg-cache] base-case → chart total MISS redis=${_totalMs}ms`);

  return singleFlight(inProcKey, async () => {
    try {
      const filters = await resolveFilters(query_in);
      const total = await getOrderCount(query_in.q ?? undefined, filters);
      await aggCacheSet(inProcKey, total);
      return total;
    } catch (err) {
      mapDbError(err, "getExactAggregateTotal");
    }
  });
}

void (process.env.CLICKHOUSE_URL && (async () => {
  const t0 = Date.now();
  console.log(`[agg:warmup] START`);
  try {
    const d = new Date(`${DATASET_END}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 90);
    const from90 = d.toISOString().slice(0, 10);

    const baseInput = { q: null, status: null, regionCode: null, minTotal: null, maxTotal: null, topCategories: 4 };
    await Promise.all([
      getDailyAggregates({ ...baseInput, from: from90,        to: DATASET_END }),
      getDailyAggregates({ ...baseInput, from: DATASET_START, to: DATASET_END }),
      getExactAggregateTotal({ ...baseInput, from: from90,        to: DATASET_END }),
      getExactAggregateTotal({ ...baseInput, from: DATASET_START, to: DATASET_END }),
    ]);
    console.log(`[agg:warmup] base done — ${Date.now() - t0}ms`);

    const page1_90 = await listOrders({ page: 1, pageSize: 20, sort: "placedAt", dir: "desc", from: from90, to: DATASET_END });

    const names = new Set<string>();
    const noteWords = new Set<string>();
    for (const order of page1_90.data) {
      if (order.customer.firstName) names.add(order.customer.firstName.toLowerCase());
      if (order.customer.lastName)  names.add(order.customer.lastName.toLowerCase());
      if (order.notes) {
        for (const w of order.notes.split(/\s+/)) {
          const clean = w.replace(/[^a-z0-9]/gi, "").toLowerCase();
          if (clean.length >= 3 && !/^\d+$/.test(clean)) noteWords.add(clean);
        }
      }
    }
    const tokenList = [...names, ...[...noteWords].filter(w => !names.has(w))];
    console.log(`[agg:warmup] token list (${tokenList.length} tokens, page-1 90d) — ${Date.now() - t0}ms`);

    for (let i = 0; i < tokenList.length; i++) {
      const tok = tokenList[i];
      const tokInput = { ...baseInput, q: tok };
      await getDailyAggregates({    ...tokInput, from: from90,        to: DATASET_END });
      await getDailyAggregates({    ...tokInput, from: DATASET_START, to: DATASET_END });
      await getExactAggregateTotal({ ...tokInput, from: from90,        to: DATASET_END });
      await getExactAggregateTotal({ ...tokInput, from: DATASET_START, to: DATASET_END });
      if ((i + 1) % 10 === 0) console.log(`[agg:warmup] ${i + 1}/${tokenList.length} tokens — ${Date.now() - t0}ms`);
    }
    console.log(`[agg:warmup] COMPLETE — ${tokenList.length} tokens × 2 date ranges in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`[agg:warmup] ERROR at ${Date.now() - t0}ms — ${e}`);
  }
})());
