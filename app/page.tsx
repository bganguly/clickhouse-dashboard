"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Chart from "@/components/Chart";
import SearchTable, { type SearchRow } from "@/components/SearchTable";
import LiveFeed, { type LiveEvent } from "@/components/LiveFeed";
import ThemeToggle from "@/components/ThemeToggle";
import FilterSidebar, {
  EMPTY_FILTERS,
  type OrderFilters,
  type RegionOption,
} from "@/components/FilterSidebar";

/** Merge new regions into the list by code (name wins if present), sorted. */
function mergeRegions(
  prev: RegionOption[],
  incoming: RegionOption[],
): RegionOption[] {
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

/**
 * Dashboard shell. A single SSE connection lives in LiveFeed; each event bumps
 * `refreshSignal`, which Chart and SearchTable watch to refetch their current
 * views. This keeps one EventSource for the whole page instead of one per panel.
 *
 * The filter sidebar's state lives here and is passed to SearchTable, which
 * sends it to /api/orders. Region options have no dedicated endpoint, so they
 * are discovered from the order rows SearchTable reports via `onRows`.
 */
/** Local date (YYYY-MM-DD) for an event's timestamp, matching the chart's
 *  bucket keys. Falls back to "now" when the event carries no usable time. */
function eventDay(raw: unknown): string | undefined {
  const d = raw != null ? new Date(raw as string) : new Date();
  if (Number.isNaN(d.getTime())) return undefined;
  const tzMs = d.getTime() - d.getTimezoneOffset() * 60_000;
  return new Date(tzMs).toISOString().slice(0, 10);
}

const QUICK_ORDER_URL = process.env.NEXT_PUBLIC_QUICK_ORDER_URL ?? "http://localhost:3005";

const QUICK_ORDER_DEV_DIR =
  "/Users/bikram/Personal/interview-prep/grouped-projects/nextjs/websockets-quickorder";

export default function Dashboard() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [quickOrderUnavailable, setQuickOrderUnavailable] = useState(false);
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);
  // Active search query, lifted from SearchTable so the chart can match it.
  const [searchQuery, setSearchQuery] = useState("");
  // Chart's client-side summed Total tile, propagated down to SearchTable's
  // list footer so both numbers are always the same figure (see Chart's
  // onTotalChange). Reset to null on filter/search changes below so the list
  // shows a skeleton rather than a stale number while new chart data loads.
  const [chartTotal, setChartTotal] = useState<number | null>(null);
  // Category whose aggregate tile should briefly pulse after an SSE order.
  const [updatingSlug, setUpdatingSlug] = useState<string | null>(null);
  // Last SSE order, used to patch the chart's bars IN PLACE (Task 16) instead of
  // refetching — refetching cleared the bars and caused the FOUC / layout bounce.
  const [lastSseOrder, setLastSseOrder] = useState<{
    categorySlug: string;
    placedAt: string;
  } | null>(null);
  // Most recent order event, used to target the row + chart-bucket animations.
  const [lastOrder, setLastOrder] = useState<{
    id?: string | number;
    date?: string;
    seq: number;
  } | null>(null);

  const handleEvent = useCallback((event: LiveEvent) => {
    // Only order events carry an id — heartbeats and connected events don't, and
    // must NOT trigger a refetch (otherwise the list repaints on every beat).
    if (event.id == null) return;
    const id = event.id;
    const date = eventDay(event.placedAt ?? event.timestamp);
    setRefreshSignal((n) => {
      setLastOrder({ id, date, seq: n + 1 });
      return n + 1;
    });
    // Pulse only the affected category's aggregate tile (Task 14). Depends on
    // wt1 including `categorySlug` on the SSE order payload; absent it, no tile
    // pulses (the rest of the refresh still runs).
    const slug =
      typeof event.categorySlug === "string" ? event.categorySlug : null;
    if (slug) {
      setUpdatingSlug(slug);
      setTimeout(() => setUpdatingSlug(null), 500);
      // Hand the chart an in-place patch instead of a refetch (Task 16). Pass
      // the SAME normalized local day used for the bucket pulse so the patch and
      // pulse target the same bar (Chart slices placedAt to 10 chars). Fall back
      // to the raw timestamp only when the day couldn't be derived. A fresh
      // object every time so the patch effect fires for repeat categories too.
      const placedAt =
        date ??
        (typeof event.placedAt === "string"
          ? event.placedAt
          : typeof event.timestamp === "string"
            ? event.timestamp
            : "");
      setLastSseOrder({ categorySlug: slug, placedAt });
    }
  }, []);

  // Prefer the full region list (with display names) from /api/regions. If that
  // endpoint isn't available we fall back to codes discovered from order rows.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/regions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: RegionOption[]) => {
        if (cancelled || !Array.isArray(data)) return;
        setRegionOptions((prev) => mergeRegions(prev, data));
      })
      .catch(() => {
        /* no regions endpoint — handleRows discovery covers it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Discover region codes from loaded orders (fallback / supplement; uses the
  // region name from the row when present, else the code).
  const handleRows = useCallback((rows: SearchRow[]) => {
    const incoming: RegionOption[] = [];
    for (const row of rows) {
      const region = row.region as { code?: string; name?: string } | undefined;
      if (region?.code) {
        incoming.push({ code: region.code, name: region.name ?? region.code });
      }
    }
    if (incoming.length === 0) return;
    setRegionOptions((prev) => mergeRegions(prev, incoming));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
            {process.env.NEXT_PUBLIC_DEMO_SCALE && (
              <span className="inline-block mt-1 text-[11px] px-2 py-0.5 rounded-full font-medium"
                style={{ background:"rgba(99,102,241,0.10)", border:"1px solid rgba(99,102,241,0.25)", color:"#818cf8" }}>
                demo · {process.env.NEXT_PUBLIC_DEMO_SCALE}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-500 select-none">
                <input
                  type="checkbox"
                  checked={liveEnabled}
                  onChange={async (e) => {
                    const on = e.target.checked;
                    setLiveEnabled(on);
                    if (!on) {
                      setQuickOrderUnavailable(false);
                      return;
                    }
                    try {
                      await fetch(QUICK_ORDER_URL, {
                        mode: "no-cors",
                        signal: AbortSignal.timeout(1500),
                      });
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
            <ThemeToggle />
          </div>
        </header>

        {liveEnabled && quickOrderUnavailable && (
          <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">
              Quick Order UI isn&apos;t running at {QUICK_ORDER_URL}.
            </p>
            <p className="mt-1">Start it, then re-check the Live box:</p>
            <pre className="mt-1 overflow-x-auto rounded bg-black/5 px-2 py-1 font-mono text-xs dark:bg-white/10">
              cd {QUICK_ORDER_DEV_DIR} && npm run dev
            </pre>
          </div>
        )}

        <div className="flex flex-col gap-6 lg:flex-row">
          <FilterSidebar
            value={filters}
            onChange={setFilters}
            regionOptions={regionOptions}
          />

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
                  onRangeChange={(range) =>
                    setFilters((f) => ({ ...f, from: range.from, to: range.to }))
                  }
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
