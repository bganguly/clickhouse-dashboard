"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Legend,
  Rectangle,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useIsDark } from "@/hooks/useIsDark";
import { appendFilterParams, type OrderFilters } from "@/components/FilterSidebar";

/** One x-axis bucket. `date` is the label; every other numeric key is a stack series. */
export interface AggregateBucket {
  date: string;
  [series: string]: string | number;
}

/** Per-category metrics within a date, as sent by the backend. */
interface RawCategory {
  totalOrders?: number;
  totalRevenue?: number;
  totalItems?: number;
  avgOrderValue?: number;
}

/**
 * Raw backend row: a date plus its per-category breakdown, keyed by category
 * name (an object, not an array): `{ "Category 1": { totalRevenue, ... } }`.
 */
export interface RawAggregate {
  date: string;
  categories: Record<string, RawCategory>;
}

interface AggregatesResponse {
  data: RawAggregate[];
  /** Exact distinct order count for this range/filters — see
   *  getExactAggregateTotal. Preferred over summing category rows, which
   *  double-counts any order whose items span more than one category. */
  totalOrders?: number;
}

const DEFAULT_TOP_N = 4;
const OTHER_KEY = "Others";
const OTHER_COLOR = "#94a3b8"; // slate-400

/** Whether a category name is a roll-up bucket ("Other"/"Others"), case-insensitive. */
function isOtherCategory(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "other" || n === "others";
}

export interface CategoryTotal {
  category: string;
  revenue: number;
  orders: number;
}

/** Sum revenue and order count per category across the range, sorted desc. */
function computeCategoryTotals(data: RawAggregate[]): CategoryTotal[] {
  const map = new Map<string, { revenue: number; orders: number }>();
  for (const entry of data) {
    for (const [category, c] of Object.entries(entry.categories ?? {})) {
      const prev = map.get(category) ?? { revenue: 0, orders: 0 };
      prev.revenue += c.totalRevenue ?? 0;
      prev.orders += c.totalOrders ?? 0;
      map.set(category, prev);
    }
  }
  return [...map.entries()]
    .map(([category, v]) => ({ category, revenue: v.revenue, orders: v.orders }))
    .sort((a, b) => b.orders - a.orders);
}

/**
 * Build one stacked bucket per date, keeping only `topCategories` as their own
 * revenue series and rolling every other category into a single "Other" series.
 */
function buildBucket(
  entry: RawAggregate,
  topCategories: string[],
  withOther: boolean,
): AggregateBucket {
  const top = new Set(topCategories);
  const bucket: AggregateBucket = { date: entry.date };
  for (const cat of topCategories) bucket[cat] = 0;
  if (withOther) bucket[OTHER_KEY] = 0;
  for (const [category, c] of Object.entries(entry.categories ?? {})) {
    const value = c.totalOrders ?? 0;
    const key = top.has(category) ? category : withOther ? OTHER_KEY : null;
    if (key === null) continue;
    bucket[key] = (bucket[key] as number) + value;
  }
  return bucket;
}

/**
 * Abbreviate large revenue values for the Y axis: 25000 → "25k", 1_200_000 →
 * "1.2M". Hand-rolled (rather than Intl compact) to keep lowercase "k" and
 * avoid the "25K" casing surprise. Drops the decimal on round values.
 */
const compactNumber = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000)
    return `${(n / 1_000_000).toFixed(abs % 1_000_000 ? 1 : 0)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs % 1_000 ? 1 : 0)}k`;
  return `${n}`;
};

interface ChartProps {
  /** Bumped by the parent when an order event arrives. The chart keeps the
   * existing bars mounted while the authoritative aggregate refresh completes. */
  refreshSignal?: number;
  /** Last SSE order, applied as an in-place increment to the matching day's
   *  category bucket instead of triggering a full refetch (Task 16). This avoids
   *  the bars clearing + layout bounce on every order. Keyed by category NAME,
   *  same as `categories`. */
  lastSseOrder?: { categorySlug: string; placedAt: string } | null;
  /** Endpoint that returns stacked aggregates for a date range. */
  endpoint?: string;
  /** How many categories to stack individually; the rest roll into "Others". */
  topN?: number;
  /** Sidebar filters; applied to the aggregates request so the chart and totals
   *  recompute for the same filtered set as the orders table. */
  filters?: OrderFilters;
  /** Date (YYYY-MM-DD) of the most recent order; its bucket briefly pulses. */
  highlightDate?: string;
  /** Bumped per event so the same date can re-trigger the pulse. */
  highlightKey?: number;
  /** Active search query; narrows aggregates to the same matching orders. */
  searchQuery?: string;
  /** Category whose tile should briefly pulse after an SSE order (Task 14).
   *  Matched against each tile's category; null clears the pulse. */
  updatingSlug?: string | null;
  /** Controlled data path used when the dashboard fetches rows + aggregates together. */
  controlledData?: RawAggregate[] | null;
  controlledLoading?: boolean;
  controlledError?: string | null;
  onRangeChange?: (range: { from: string; to: string }) => void;
  /** Fired with the client-side summed category total whenever it changes, so
   *  the parent can hand the same number to SearchTable's list footer. */
  onTotalChange?: (n: number) => void;
}

// Stable palette for stacked series. Cycled if there are more series than colors.
const COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#ec4899",
];

const STACK_ID = "aggregates";
const DRAG_DEBOUNCE_MS = 250;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "2026-06-05" -> "Jun 5" — the Brush centers each tick label on its data
 *  point, so the first/last ticks always have half their text overflowing
 *  the plot edge. A short label keeps that overflow small enough to stay
 *  inside the chart's margin instead of being clipped by the container. */
function compactBrushDate(value: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function defaultRange(): { from: string; to: string } {
  return { from: "2020-01-01", to: isoDay(new Date()) };
}

export default function Chart({
  refreshSignal = 0,
  endpoint = "/api/aggregates",
  topN = DEFAULT_TOP_N,
  filters,
  highlightDate,
  highlightKey,
  searchQuery,
  updatingSlug,
  lastSseOrder,
  controlledData,
  controlledLoading = false,
  controlledError = null,
  onRangeChange,
  onTotalChange,
}: ChartProps) {
  const [rawData, setRawData] = useState<RawAggregate[]>([]);
  const [range, setRange] = useState(defaultRange);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Exact order count from the API response. null while a fetch is in flight
  // (shows a skeleton in the Total tile). Set from json.totalOrders on settle.
  const [apiTotal, setApiTotal] = useState<number | null>(null);
  // Date whose bar is currently pulsing after a new order (transient).
  const [pulseDate, setPulseDate] = useState<string | null>(null);
  // Category whose chart bar should briefly flash (brightness pop) after an SSE
  // order lands (Task 17) — the visible companion to the in-place patch above.
  const [flashSlug, setFlashSlug] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  // Abort in-flight requests so rapid drags don't race each other.
  const abortRef = useRef<AbortController | null>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // onRangeChange is an independent side-channel (e.g. syncing the brushed
  // window into the shared filters so the list narrows too) — it does NOT
  // imply controlled mode. Only supplying controlledData does.
  const isControlled = controlledData !== undefined;
  // A brush drag calls fetchAggregates directly, then (via onRangeChange)
  // updates the parent's filters — which changes filters?.from/to and
  // re-fires the effect below with the exact same resulting request. Track
  // the last request's querystring so that echo is a no-op instead of a
  // second full round trip to the backend.
  const lastRequestKeyRef = useRef<string | null>(null);
  // Track the last refreshSignal value seen by the fetch effect so we can
  // detect SSE-driven refetches and bypass the dedup guard for those.
  const lastRefreshSignalRef = useRef(refreshSignal);

  const fetchAggregates = useCallback(
    async (from: string, to: string) => {
      // A date filter, if set, overrides the brush/default range; the other
      // filters (status, region, total) narrow the same set as the table.
      const params = new URLSearchParams({
        from: filters?.from || from,
        to: filters?.to || to,
      });
      params.set("topCategories", String(topN));
      // Sets status/regionCode/minTotal/maxTotal (and from/to if filtered).
      appendFilterParams(params, filters);
      // Narrow to the active text search, matching the orders table.
      if (searchQuery) params.set("q", searchQuery);
      const requestKey = params.toString();
      if (requestKey === lastRequestKeyRef.current) return;
      lastRequestKeyRef.current = requestKey;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      setApiTotal(null); // show skeleton in Total tile while in flight
      // NOTE: do NOT clear rawData here. Clearing on every load caused the chart
      // to flash empty (FOUC) on SSE-driven refreshes. SSE no longer refetches
      // (see the lastSseOrder patch effect); user-driven fetches replace the
      // bars atomically when the response lands.
      try {
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: AggregatesResponse = await res.json();
        // An aborted controller doesn't guarantee its fetch promise rejects
        // before a newer, faster request's promise resolves — without this
        // guard, a slower stale response can land after and silently
        // overwrite the correct state from the request that superseded it.
        if (abortRef.current !== controller) return;
        setRawData(Array.isArray(json.data) ? json.data : []);
        setApiTotal(json.totalOrders ?? null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (abortRef.current !== controller) return;
        lastRequestKeyRef.current = null; // allow a retry of the same params after a real failure
        setError((err as Error).message);
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    },
    [endpoint, topN, filters, searchQuery],
  );

  // Initial load + refetch on user-driven changes and order events. The fetch
  // path intentionally does not clear rawData, so SSE refreshes update the chart
  // without the old blank/flicker behavior.
  //
  // from/to are recomputed from filters (not read from `range` state) so that
  // clearing a sidebar date field takes effect immediately: `range` is only
  // ever written by a brush drag, and once brush-drag also started syncing
  // into `filters` (onRangeChange), a stale `range.to` left behind after the
  // filter was cleared would otherwise keep silently narrowing every refetch
  // via fetchAggregates' `filters?.to || to` fallback forever.
  useEffect(() => {
    if (isControlled) return;
    const from = filters?.from || defaultRange().from;
    const to = filters?.to || defaultRange().to;
    // Keep the displayed range (header text, brush position) in sync too.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRange({ from, to });
    // SSE events bump refreshSignal without changing filters — same params,
    // so the dedup guard inside fetchAggregates would block the refetch. Clear
    // the key when refreshSignal advances so SSE-driven fetches always go through.
    if (refreshSignal !== lastRefreshSignalRef.current) {
      lastRefreshSignalRef.current = refreshSignal;
      lastRequestKeyRef.current = null;
    }
    // Kicks off an async fetch (which toggles loading state); intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAggregates(from, to);
  }, [fetchAggregates, isControlled, refreshSignal, filters?.from, filters?.to]);

  useEffect(() => {
    if (!isControlled) return;
    if (!controlledData) return;
    // Controlled data is supplied by the parent after one combined dashboard fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRawData(Array.isArray(controlledData) ? controlledData : []);
    setError(null);
  }, [controlledData, isControlled]);

  useEffect(() => {
    if (!isControlled) return;
    // Controlled errors mirror the parent combined request state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(controlledError);
  }, [controlledError, isControlled]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (dragTimer.current) clearTimeout(dragTimer.current);
    };
  }, []);

  // Incremental patch for SSE orders (Task 16): bump the matching day's category
  // count in place instead of refetching. Keeps every bar mounted (no FOUC) and
  // leaves the chart layout stable. If the order's day isn't in the loaded
  // window, leave the data untouched — a refetch would clear the bars, which is
  // exactly what we're avoiding.
  const lastPatched = useRef<{ categorySlug: string; placedAt: string } | null>(
    null,
  );
  useEffect(() => {
    if (!lastSseOrder) return;
    if (lastSseOrder === lastPatched.current) return;
    lastPatched.current = lastSseOrder;
    // A blind +1 is only safe when nothing could exclude the new order — with
    // a search/filter active, we can't tell from categorySlug/placedAt alone
    // whether it actually matches, so skip the optimistic bump and let the
    // refetch triggered by the same SSE event (see refreshSignal effect above)
    // supply the correct, properly-filtered count instead.
    const filtered = Boolean(
      searchQuery ||
        filters?.status?.length ||
        filters?.regionCodes?.length ||
        filters?.from ||
        filters?.to ||
        filters?.totalMin ||
        filters?.totalMax,
    );
    if (filtered) return;
    const { categorySlug, placedAt } = lastSseOrder;
    if (!categorySlug || !placedAt) return;
    const day = placedAt.slice(0, 10);
    if (!rawData.some((entry) => entry.date === day)) return; // day not in window — don't disturb anything
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRawData((prev) => {
      const idx = prev.findIndex((entry) => entry.date === day);
      if (idx === -1) return prev; // day not in window — don't disturb the bars
      const entry = prev[idx];
      const cat = entry.categories?.[categorySlug];
      const nextCat: RawCategory = cat
        ? { ...cat, totalOrders: (cat.totalOrders ?? 0) + 1, totalItems: (cat.totalItems ?? 0) + 1 }
        : { totalOrders: 1, totalItems: 1, totalRevenue: 0 };
      const next = prev.slice();
      next[idx] = {
        ...entry,
        categories: { ...entry.categories, [categorySlug]: nextCat },
      };
      return next;
    });
    // matchedOrders = apiTotal ?? summedCategoryOrders: apiTotal takes precedence
    // when set, so the Total tile and onTotalChange stay stale without this bump.
    setApiTotal((prev) => (prev != null ? prev + 1 : prev));
    // searchQuery/filters intentionally omitted: read via closure at the
    // render where lastSseOrder changed, which is what we want — re-running
    // this effect on a pure filter change (no new order) would be a no-op
    // anyway since the lastPatched guard above already blocks reprocessing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSseOrder]);

  // Bar flash (Task 17): when an SSE order lands, brighten the affected
  // category's bar for ~600ms so the in-place patch is unmistakable.
  useEffect(() => {
    if (!lastSseOrder) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlashSlug(lastSseOrder.categorySlug);
    const t = setTimeout(() => setFlashSlug(null), 600);
    return () => clearTimeout(t);
  }, [lastSseOrder]);

  const isDark = useIsDark();
  // recharts renders raw SVG and can't use Tailwind `dark:` utilities, so pick
  // grid/axis/tooltip colors from the resolved theme.
  const gridStroke = isDark ? "#374151" : "#e5e7eb";
  const axisColor = isDark ? "#9ca3af" : "#6b7280";
  const tooltipStyle = {
    backgroundColor: isDark ? "#1f2937" : "#ffffff",
    border: `1px solid ${isDark ? "#374151" : "#e5e7eb"}`,
    borderRadius: 8,
    color: isDark ? "#f3f4f6" : "#111827",
  };

  // Per-category totals for the current range (drives the summary table).
  const categoryTotals = useMemo(
    () => computeCategoryTotals(rawData),
    [rawData],
  );

  // Client-side sum of per-category counts — fallback for the Total tile when
  // apiTotal hasn't settled yet (e.g. controlled mode, or error path).
  const summedCategoryOrders = useMemo(
    () =>
      rawData.reduce((sum, day) => {
        const dayTotal = Object.values(day.categories ?? {}).reduce(
          (s, c) => s + (c.totalOrders ?? 0),
          0,
        );
        return sum + dayTotal;
      }, 0),
    [rawData],
  );
  const matchedOrders = apiTotal ?? summedCategoryOrders;

  // Use a ref so the effect below doesn't need onTotalChange as a dep
  // (avoids recreating the effect when the parent re-renders).
  const onTotalChangeRef = useRef(onTotalChange);
  useEffect(() => { onTotalChangeRef.current = onTotalChange; });

  // Propagate the settled API total to the parent so SearchTable's list footer
  // can show the exact same figure instead of its own (potentially capped) total.
  useEffect(() => {
    if (apiTotal == null) return;
    onTotalChangeRef.current?.(apiTotal);
  }, [apiTotal]);

  // Stack only the top N *real* categories; everything else (including any
  // backend-provided "Other"/"Others" pseudo-category) rolls into a single
  // "Others" series.
  const topCategories = useMemo(
    () =>
      categoryTotals
        .filter((c) => !isOtherCategory(c.category))
        .slice(0, topN)
        .map((c) => c.category),
    [categoryTotals, topN],
  );
  const withOther = categoryTotals.length > topCategories.length;

  const buckets = useMemo(
    () => rawData.map((entry) => buildBucket(entry, topCategories, withOther)),
    [rawData, topCategories, withOther],
  );

  // Pulse the new order's bucket once its date is present in the loaded data.
  const lastPulseKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (highlightKey == null || !highlightDate) return;
    if (highlightKey === lastPulseKey.current) return;
    if (!buckets.some((b) => b.date === highlightDate)) return;
    lastPulseKey.current = highlightKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPulseDate(highlightDate);
    const t = setTimeout(() => setPulseDate(null), 2700);
    return () => clearTimeout(t);
  }, [buckets, highlightKey, highlightDate]);

  // All displayed segments (top categories + a single rolled-up "Others")
  // ranked by revenue desc. "Others" participates in this sort, so the largest
  // segment — whatever it is — leads the order.
  const seriesRanked = useMemo(() => {
    const topSet = new Set(topCategories);
    const entries = topCategories.map((cat) => ({
      key: cat,
      orders: categoryTotals.find((c) => c.category === cat)?.orders ?? 0,
    }));
    if (withOther) {
      const othersOrders = categoryTotals
        .filter((c) => !topSet.has(c.category))
        .reduce((sum, c) => sum + c.orders, 0);
      entries.push({ key: OTHER_KEY, orders: othersOrders });
    }
    return entries.sort((a, b) => b.orders - a.orders);
  }, [categoryTotals, topCategories, withOther]);

  // Stack/legend order: ranked top categories plus "Others". Recharts draws
  // the first <Bar> at the BOTTOM, so largest-first puts the largest at the
  // bottom and the smallest on top; the legend reads the same order left-to-right.
  const seriesKeys = useMemo(
    () => seriesRanked
      .filter((s) => showOthers || s.key !== OTHER_KEY)
      .map((s) => s.key),
    [seriesRanked, showOthers],
  );

  // Color per top category (by rank), with a fixed neutral for "Other".
  const colorByCategory = useMemo(() => {
    const map = new Map<string, string>();
    topCategories.forEach((c, i) => map.set(c, COLORS[i % COLORS.length]));
    return map;
  }, [topCategories]);
  const colorFor = (key: string) =>
    key === OTHER_KEY ? OTHER_COLOR : (colorByCategory.get(key) ?? OTHER_COLOR);

  // Totals row: top categories first in legend order (revenue desc), then
  // "Others" always pinned last regardless of its size.
  const displayTotals = useMemo(() => {
    const tops = seriesRanked
      .filter((s) => s.key !== OTHER_KEY)
      .map((s) => ({ category: s.key, orders: s.orders }));
    const others = seriesRanked.find((s) => s.key === OTHER_KEY);
    if (others) tops.push({ category: others.key, orders: others.orders });
    return tops;
  }, [seriesRanked]);

  // Dragging the Brush selects a date window; debounce then refetch that window.
  const handleBrushChange = useCallback(
    (next: { startIndex?: number; endIndex?: number }) => {
      const { startIndex, endIndex } = next;
      if (
        startIndex == null ||
        endIndex == null ||
        !buckets.length ||
        startIndex < 0 ||
        endIndex >= buckets.length
      ) {
        return;
      }
      const from = String(buckets[startIndex].date);
      const to = String(buckets[endIndex].date);
      if (from === range.from && to === range.to) return;

      setRange({ from, to });
      if (dragTimer.current) clearTimeout(dragTimer.current);
      dragTimer.current = setTimeout(() => {
        if (!isControlled) fetchAggregates(from, to);
        // Notify the parent regardless of controlled/uncontrolled mode, so it
        // can sync the brushed window into shared filters (e.g. so the list
        // narrows to the same range the chart is now showing).
        onRangeChange?.({ from, to });
      }, DRAG_DEBOUNCE_MS);
    },
    [
      buckets,
      range.from,
      range.to,
      fetchAggregates,
      isControlled,
      onRangeChange,
    ],
  );

  return (
    <section
      data-testid="chart"
      // `data-loading` mirrors the internal fetch state so wt3 can assert the
      // refetch window; `relative overflow-hidden` clips the ::before sweep bar.
      data-loading={
        (isControlled ? controlledLoading : loading) ? "true" : undefined
      }
      className="relative overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Aggregates</h2>
          <p className="text-xs text-gray-500">
            {range.from} → {range.to}
            <span className="ml-2 text-gray-400">drag the slider to rescan</span>
          </p>
        </div>
        {(isControlled ? controlledLoading : loading) && (
          <span className="text-xs text-indigo-500" aria-live="polite">
            updating…
          </span>
        )}
      </header>

      {error ? (
        <div className="flex h-72 items-center justify-center text-sm text-red-500">
          Failed to load aggregates: {error}
        </div>
      ) : buckets.length === 0 ? (
        <div className="flex h-72 items-center justify-center text-sm text-gray-400">
          {(isControlled ? controlledLoading : loading)
            ? "Loading…"
            : "No data for this range."}
        </div>
      ) : (
        <>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            data={buckets}
            // The Y-axis (width={56} below) sits inside the left margin, so a
            // numerically equal left/right margin still leaves far less real
            // buffer on the right — right is padded by the Y-axis width too
            // so both sides give the Brush's edge labels the same clearance.
            margin={{ top: 8, right: 8 + 56, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="date"
              fontSize={12}
              tickMargin={8}
              stroke={axisColor}
              tick={{ fill: axisColor }}
            />
            <YAxis
              fontSize={12}
              width={56}
              stroke={axisColor}
              tick={{ fill: axisColor }}
              tickFormatter={compactNumber}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: tooltipStyle.color }}
              itemStyle={{ color: tooltipStyle.color }}
              cursor={{ fill: isDark ? "#ffffff10" : "#00000008" }}
              formatter={(v) => Number(v).toLocaleString()}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              // Render straight from `displayTotals` so the legend doubles as
              // the totals row (single line), matching the GCP frontend —
              // ranked top categories, then "Others" pinned last.
              content={() => (
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-xs">
                  {displayTotals
                    .filter((ct) => ct.category !== OTHER_KEY)
                    .map((ct) => (
                      <span
                        key={ct.category}
                        data-testid="aggregate-tile"
                        // The tile's category is its identity; wt1's SSE
                        // `categorySlug` must carry this same value for the
                        // right tile to pulse.
                        data-category={ct.category}
                        data-updating={
                          updatingSlug != null && updatingSlug === ct.category
                            ? "true"
                            : undefined
                        }
                        className="inline-flex items-center gap-1.5 whitespace-nowrap"
                        style={{ color: axisColor }}
                      >
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: colorFor(ct.category) }}
                        />
                        {ct.category}
                        <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                          {ct.orders.toLocaleString()}
                        </span>
                      </span>
                    ))}
                  {withOther &&
                    (() => {
                      const othersTotal = displayTotals.find(
                        (ct) => ct.category === OTHER_KEY,
                      );
                      return (
                        <label
                          className="inline-flex cursor-pointer items-center gap-1.5"
                          style={{ color: axisColor }}
                        >
                          <input
                            type="checkbox"
                            checked={showOthers}
                            onChange={(e) => setShowOthers(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            data-testid="chart-show-others"
                          />
                          Others
                          {othersTotal && (
                            <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                              {othersTotal.orders.toLocaleString()}
                            </span>
                          )}
                        </label>
                      );
                    })()}
                  <span
                    data-testid="aggregate-tile-total"
                    data-total={apiTotal ?? undefined}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap border-l border-gray-200 pl-4 font-medium dark:border-gray-700"
                    style={{ color: axisColor }}
                  >
                    Total
                    <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                      {apiTotal == null ? (
                        <span
                          aria-hidden
                          className="inline-block h-3 w-10 animate-pulse rounded bg-gray-200 align-middle dark:bg-gray-700"
                        />
                      ) : (
                        matchedOrders.toLocaleString()
                      )}
                    </span>
                  </span>
                </div>
              )}
            />
            {pulseDate && (
              <ReferenceLine
                x={pulseDate}
                stroke="#6366f1"
                strokeWidth={2}
                className="bucket-pulse"
                ifOverflow="extendDomain"
                label={{
                  value: "＋ new",
                  position: "top",
                  fill: "#6366f1",
                  fontSize: 11,
                }}
              />
            )}
            {seriesKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId={STACK_ID}
                fill={colorFor(key)}
                radius={
                  i === seriesKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]
                }
                // recharts doesn't pass plain data-* through <Bar> to the rect,
                // so render each rect inside a <g> that carries the test hooks
                // and the data-flash brightness pop (Task 17).
                shape={(props: object) => (
                  <g
                    data-testid="chart-bar"
                    data-category={key}
                    data-flash={flashSlug === key ? "true" : undefined}
                  >
                    <Rectangle {...props} />
                  </g>
                )}
              />
            ))}
            <Brush
              dataKey="date"
              height={28}
              stroke="#6366f1"
              fill={isDark ? "#111827" : "#ffffff"}
              travellerWidth={10}
              tickFormatter={compactBrushDate}
              onChange={handleBrushChange}
            />
          </BarChart>
        </ResponsiveContainer>
        </>
      )}
    </section>
  );
}
