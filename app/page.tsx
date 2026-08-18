"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { searchPerf } from "@/lib/search-perf";
import { diag } from "@/lib/diag";

function PerfTimer({ ms, settled }: { ms: number | null; settled: boolean }) {
  if (ms === null) return null;
  const label = settled ? `↓ ${ms} ms` : `⏱ ${ms} ms`;
  const style = settled
    ? { background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.28)", color: "#4ade80" }
    : { background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.28)", color: "#fbbf24" };
  return (
    <span className="inline-flex items-center text-[11px] font-mono px-2 py-0.5 rounded-full tabular-nums" style={style}>
      {label}
    </span>
  );
}
import Chart from "@/components/Chart";
import SearchTable, { type SearchRow } from "@/components/SearchTable";
import LiveFeed, { type LiveEvent } from "@/components/LiveFeed";
import ThemeToggle from "@/components/ThemeToggle";
import FilterSidebar, {
  EMPTY_FILTERS,
  type OrderFilters,
  type RegionOption,
} from "@/components/FilterSidebar";

function mergeRegions(prev: RegionOption[], incoming: RegionOption[]): RegionOption[] {
  const map = new Map(prev.map((r) => [r.code, r]));
  let changed = false;
  for (const r of incoming) {
    if (!r?.code) continue;
    const existing = map.get(r.code);
    const name = r.name || existing?.name || r.code;
    if (!existing || existing.name !== name) {
      map.set(r.code, { code: r.code, name });
      changed = true;
    }
  }
  if (!changed) return prev;
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function eventDay(raw: unknown): string | undefined {
  const d = raw != null ? new Date(raw as string) : new Date();
  if (Number.isNaN(d.getTime())) return undefined;
  const tzMs = d.getTime() - d.getTimezoneOffset() * 60_000;
  return new Date(tzMs).toISOString().slice(0, 10);
}


const QUICK_ORDER_URL = process.env.NEXT_PUBLIC_QUICK_ORDER_URL ?? "http://localhost:3005";

export default function Dashboard() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [quickOrderUnavailable, setQuickOrderUnavailable] = useState(false);
  const [datasetBounds, setDatasetBounds] = useState<{ from: string; to: string } | null>(null);
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [chartTotal, setChartTotal] = useState<number | null>(null);
  const [updatingSlug, setUpdatingSlug] = useState<string | null>(null);
  const [lastSseOrder, setLastSseOrder] = useState<{ categorySlug: string; placedAt: string } | null>(null);
  const [lastOrder, setLastOrder] = useState<{ id?: string | number; date?: string; seq: number } | null>(null);

  const [dbStatus, setDbStatus] = useState<"waking" | "ready" | null>(null);
  const dbStatusDismiss = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chartLoading, setChartLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [perfMs, setPerfMs] = useState<number | null>(null);
  const [perfSettled, setPerfSettled] = useState(false);
  const perfStart = useRef<number>(0);
  const perfInterval = useRef<number | null>(null);
  const perfHide = useRef<ReturnType<typeof setTimeout> | null>(null);
  const perfActive = useRef(false);

  const handleChartLoading = useCallback((v: boolean) => setChartLoading(v), []);
  const handleTableLoading = useCallback((v: boolean) => setTableLoading(v), []);
  const handleRangeChange = useCallback(
    (range: { from: string; to: string }) => setFilters((f) => ({ ...f, from: range.from, to: range.to })),
    [],
  );
  const handleCountChange = useCallback((n: number) => setChartTotal((c) => c ?? n), []);

  const handleSearchStart = useCallback(() => {
    if (perfActive.current) return;
    perfActive.current = true;
    perfStart.current = performance.now();
    searchPerf.start(); // same instant — all [perf:client] counter= values map to the displayed ms
    setPerfMs(0);
    setPerfSettled(false);
    if (perfHide.current) { clearTimeout(perfHide.current); perfHide.current = null; }
    if (perfInterval.current) { clearInterval(perfInterval.current); perfInterval.current = null; }
    const tick = () => setPerfMs(Math.round(performance.now() - perfStart.current));
    tick();
    perfInterval.current = window.setInterval(tick, 100);
  }, []);

  useEffect(() => {
    const anyLoading = chartLoading || tableLoading;
    if (anyLoading && !perfActive.current) {
      perfActive.current = true;
      perfStart.current = performance.now();
      searchPerf.start();
      if (diag) console.log("[perf:client] 🔄 loading started (initial/clear) — COUNTER STARTS (0ms)");
      setPerfSettled(false);
      if (perfHide.current) { clearTimeout(perfHide.current); perfHide.current = null; }
      if (perfInterval.current) { clearInterval(perfInterval.current); perfInterval.current = null; }
      const tick = () => setPerfMs(Math.round(performance.now() - perfStart.current));
      tick();
      perfInterval.current = window.setInterval(tick, 100);
    } else if (!anyLoading && perfActive.current) {
      perfActive.current = false;
      if (perfInterval.current) { clearInterval(perfInterval.current); perfInterval.current = null; }
      const ms = Math.round(performance.now() - perfStart.current);
      if (diag) console.log(`[perf:client] ✓ COUNTER STOPS — render settled ${ms}ms`);
      setPerfMs(ms);
      setPerfSettled(true);
      perfHide.current = setTimeout(() => { setPerfMs(null); setPerfSettled(false); }, 3500);
    }
  }, [chartLoading, tableLoading]);

  const handleEvent = useCallback((event: LiveEvent) => {
    if (event.id == null) return;
    const id = event.id;
    const date = eventDay(event.placedAt ?? event.timestamp);
    setRefreshSignal((n) => {
      setLastOrder({ id, date, seq: n + 1 });
      return n + 1;
    });
    const slug = typeof event.categorySlug === "string" ? event.categorySlug : null;
    if (slug) {
      setUpdatingSlug(slug);
      setTimeout(() => setUpdatingSlug(null), 500);
      const placedAt =
        date ??
        (typeof event.placedAt === "string" ? event.placedAt
          : typeof event.timestamp === "string" ? event.timestamp : "");
      setLastSseOrder({ categorySlug: slug, placedAt });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dataset-bounds")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((bounds: { from: string; to: string }) => {
        if (cancelled) return;
        setDatasetBounds(bounds);
        const d = new Date(`${bounds.to}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 90);
        const from = d.toISOString().slice(0, 10);
        setFilters((f) => ({ ...f, from, to: bounds.to }));
      })
      .catch(() => {
        if (cancelled) return;
        const to = new Date().toISOString().slice(0, 10);
        const d = new Date();
        d.setDate(d.getDate() - 90);
        const from = d.toISOString().slice(0, 10);
        setDatasetBounds({ from: "2024-07-17", to });
        setFilters((f) => ({ ...f, from, to }));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/regions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: RegionOption[]) => {
        if (cancelled || !Array.isArray(data)) return;
        setRegionOptions((prev) => mergeRegions(prev, data));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const wakeTimer = setTimeout(() => { if (!cancelled) setDbStatus("waking"); }, 800);
    fetch("/api/ping")
      .then((r) => r.json() as Promise<{ ok: boolean; ms: number }>)
      .then(({ ms }) => {
        if (cancelled) return;
        clearTimeout(wakeTimer);
        if (ms > 800) {
          setDbStatus("ready");
          dbStatusDismiss.current = setTimeout(() => { if (!cancelled) setDbStatus(null); }, 2500);
        } else {
          setDbStatus(null);
        }
      })
      .catch(() => { if (!cancelled) { clearTimeout(wakeTimer); setDbStatus(null); } });
    return () => {
      cancelled = true;
      clearTimeout(wakeTimer);
      if (dbStatusDismiss.current) clearTimeout(dbStatusDismiss.current);
    };
  }, []);

  const handleRows = useCallback((rows: SearchRow[]) => {
    const incoming: RegionOption[] = [];
    for (const row of rows) {
      const region = row.region as { code?: string; name?: string } | undefined;
      if (region?.code) incoming.push({ code: region.code, name: region.name ?? region.code });
    }
    if (incoming.length === 0) return;
    setRegionOptions((prev) => mergeRegions(prev, incoming));
  }, []);

  useEffect(() => {
    setChartTotal(null);
  }, [filters, searchQuery]);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="w-full px-5 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">ClickHouse Dashboard</h1>
            <p className="text-sm text-gray-500">
              Live aggregates, search, and event stream.
            </p>
            {process.env.NEXT_PUBLIC_DEMO_SCALE && (
              <div className="mt-1">
                <span className="inline-block text-[11px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(99,102,241,0.10)", border: "1px solid rgba(99,102,241,0.25)", color: "#818cf8" }}>
                  demo · {process.env.NEXT_PUBLIC_DEMO_SCALE}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <PerfTimer ms={perfMs} settled={perfSettled} />
            {/* Live checkbox — re-enable when websockets-quickorder is running alongside
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-500 select-none">
              <input
                type="checkbox"
                checked={liveEnabled}
                onChange={async (e) => {
                  const on = e.target.checked;
                  setLiveEnabled(on);
                  if (!on) { setQuickOrderUnavailable(false); return; }
                  try {
                    await fetch(QUICK_ORDER_URL, { mode: "no-cors", signal: AbortSignal.timeout(1500) });
                    setQuickOrderUnavailable(false);
                    window.open(QUICK_ORDER_URL, "_blank");
                  } catch {
                    setQuickOrderUnavailable(true);
                  }
                }}
                className="h-4 w-4 rounded border-gray-300 accent-indigo-600"
              />
              Live
            </label>
            {liveEnabled && quickOrderUnavailable && (
              <span className="text-xs text-gray-400 dark:text-gray-500"
                title={`Quick Order not reachable at ${QUICK_ORDER_URL}`}>
                Quick Order offline
              </span>
            )}
            */}
            <ThemeToggle />
          </div>
        </header>

        {dbStatus && (
          <div
            className="mb-4 flex items-center gap-2 rounded-md px-3 py-2 text-sm"
            style={dbStatus === "waking"
              ? { background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.30)", color: "#fbbf24" }
              : { background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.30)", color: "#4ade80" }}
          >
            {dbStatus === "waking" ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                </svg>
                Database waking up…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Database ready
              </>
            )}
          </div>
        )}

        <div className="flex flex-col gap-6 lg:flex-row">
          <FilterSidebar value={filters} onChange={setFilters} regionOptions={regionOptions} datasetBounds={datasetBounds} />

          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-1 gap-6">
              <div className="space-y-6">
                {!datasetBounds ? (
                  <div className="h-96 animate-pulse rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-800 dark:bg-gray-900" />
                ) : (
                <Chart
                  refreshSignal={refreshSignal}
                  filters={filters}
                  searchQuery={searchQuery}
                  highlightDate={lastOrder?.date}
                  highlightKey={lastOrder?.seq}
                  updatingSlug={updatingSlug}
                  lastSseOrder={lastSseOrder}
                  onRangeChange={handleRangeChange}
                  onTotalChange={setChartTotal}
                  externalTotal={chartTotal}
                  onLoadingChange={handleChartLoading}
                />
                )}
                <SearchTable
                  refreshSignal={refreshSignal}
                  filters={filters}
                  onRows={handleRows}
                  onQueryChange={setSearchQuery}
                  highlightId={lastOrder?.id}
                  highlightKey={lastOrder?.seq}
                  externalTotal={chartTotal}
                  onCountChange={handleCountChange}
                  onLoadingChange={handleTableLoading}
                  onSearchStart={handleSearchStart}
                />
              </div>
              {/* LiveFeed — re-enable with liveEnabled when websockets-quickorder is running
              {liveEnabled && (
                <div className="lg:col-span-1">
                  <LiveFeed onEvent={handleEvent} />
                </div>
              )}
              */}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
