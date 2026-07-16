"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

type WarmupState = "idle" | "warming" | "ready" | "done";

function WarmupBadge() {
  const [state, setState] = useState<WarmupState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;

    async function ping() {
      try {
        const res = await fetch("/api/ch-warmup");
        const json = await res.json() as { status: string };
        if (cancelled) return;
        if (json.status === "noop") return;
        if (json.status === "ready") {
          if (state === "warming") {
            if (timerRef.current) clearInterval(timerRef.current);
            setState("ready");
            readyTimeout = setTimeout(() => { if (!cancelled) setState("done"); }, 2000);
          }
          return;
        }
        if (json.status === "warming" || res.status === 503) {
          if (state === "idle") {
            startRef.current = Date.now();
            setState("warming");
            timerRef.current = setInterval(() => {
              if (!cancelled) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
            }, 500);
          }
          setTimeout(ping, 2000);
        }
      } catch {
        if (!cancelled) setTimeout(ping, 3000);
      }
    }

    ping();
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      if (readyTimeout) clearTimeout(readyTimeout);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "idle" || state === "done") return null;

  if (state === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full font-medium"
        style={{ background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)", color: "#4ade80" }}>
        Analytics ready
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full font-medium"
      style={{ background: "rgba(251,191,36,0.10)", border: "1px solid rgba(251,191,36,0.25)", color: "#fbbf24" }}>
      <span className="animate-spin inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full" />
      Analytics warming up · {elapsed}s
    </span>
  );
}

const QUICK_ORDER_URL = process.env.NEXT_PUBLIC_QUICK_ORDER_URL ?? "http://localhost:3005";

export default function Dashboard() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [quickOrderUnavailable, setQuickOrderUnavailable] = useState(false);
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [chartTotal, setChartTotal] = useState<number | null>(null);
  const [updatingSlug, setUpdatingSlug] = useState<string | null>(null);
  const [lastSseOrder, setLastSseOrder] = useState<{ categorySlug: string; placedAt: string } | null>(null);
  const [lastOrder, setLastOrder] = useState<{ id?: string | number; date?: string; seq: number } | null>(null);

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
    fetch("/api/regions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: RegionOption[]) => {
        if (cancelled || !Array.isArray(data)) return;
        setRegionOptions((prev) => mergeRegions(prev, data));
      })
      .catch(() => {});
    return () => { cancelled = true; };
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
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-gray-500">
              Live aggregates, search, and event stream.
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {process.env.NEXT_PUBLIC_DEMO_SCALE && (
                <span className="inline-block text-[11px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(99,102,241,0.10)", border: "1px solid rgba(99,102,241,0.25)", color: "#818cf8" }}>
                  demo · {process.env.NEXT_PUBLIC_DEMO_SCALE}
                </span>
              )}
              <WarmupBadge />
            </div>
          </div>
          <div className="flex items-center gap-3">
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
            <ThemeToggle />
          </div>
        </header>

        <div className="flex flex-col gap-6 lg:flex-row">
          <FilterSidebar value={filters} onChange={setFilters} regionOptions={regionOptions} />

          <div className="min-w-0 flex-1">
            <div className={`grid grid-cols-1 gap-6${liveEnabled ? " lg:grid-cols-3" : ""}`}>
              <div className={`space-y-6${liveEnabled ? " lg:col-span-2" : ""}`}>
                <Chart
                  refreshSignal={refreshSignal}
                  filters={filters}
                  searchQuery={searchQuery}
                  highlightDate={lastOrder?.date}
                  highlightKey={lastOrder?.seq}
                  updatingSlug={updatingSlug}
                  lastSseOrder={lastSseOrder}
                  onRangeChange={(range) => setFilters((f) => ({ ...f, from: range.from, to: range.to }))}
                  onTotalChange={setChartTotal}
                />
                <SearchTable
                  refreshSignal={refreshSignal}
                  filters={filters}
                  onRows={handleRows}
                  onQueryChange={setSearchQuery}
                  highlightId={lastOrder?.id}
                  highlightKey={lastOrder?.seq}
                  externalTotal={chartTotal}
                />
              </div>
              {liveEnabled && (
                <div className="lg:col-span-1">
                  <LiveFeed onEvent={handleEvent} />
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
