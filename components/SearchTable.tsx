"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendFilterParams,
  type OrderFilters,
} from "@/components/FilterSidebar";

/** A result row. Columns are derived from the keys present in the rows. */
export type SearchRow = Record<string, unknown>;

type SortDir = "asc" | "desc";

export interface SearchResponse {
  data: SearchRow[];
  page: number;
  totalPages: number;
  total: number;
  /** True when `total` is a capped estimate (broad result set). */
  approximate?: boolean;
}

export interface TableRequestState {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  dir: SortDir;
}

interface SearchTableProps {
  /** Bumped by the SSE LiveFeed to refetch the current page on new events. */
  refreshSignal?: number;
  endpoint?: string;
  pageSize?: number;
  /** Active order filters from the sidebar. Sent as query params. */
  filters?: OrderFilters;
  /** Called with each fetched page of rows (used to discover region codes). */
  onRows?: (rows: SearchRow[]) => void;
  /** Id of the most recently created order; its row flashes when it appears. */
  highlightId?: string | number;
  /** Bumped per event so the same id can re-trigger the flash. */
  highlightKey?: number;
  /** Notified with the debounced query so the chart can narrow to the same set. */
  onQueryChange?: (q: string) => void;
  /** Controlled data path used when the dashboard fetches rows + aggregates together. */
  controlledResponse?: SearchResponse | null;
  controlledLoading?: boolean;
  controlledError?: string | null;
  onRequestStateChange?: (state: TableRequestState) => void;
}

function cn(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const moneyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function renderCustomer(row: SearchRow): string {
  const c = row.customer as
    | { firstName?: string; lastName?: string; email?: string }
    | undefined;
  if (!c) return "";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return name || c.email || "";
}

function renderItems(row: SearchRow): string {
  const items = row.items;
  return Array.isArray(items) ? String(items.length) : "";
}

function renderTotal(row: SearchRow): string {
  return typeof row.total === "number"
    ? moneyFmt.format(row.total)
    : formatCell(row.total);
}

function renderDate(row: SearchRow): string {
  const v = row.placedAt;
  if (typeof v !== "string") return formatCell(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

interface ColumnDef {
  key: string;
  label: string;
  numeric?: boolean;
  /** Sort key the backend accepts (placedAt | total | status | customer).
   *  Omitted for columns the backend can't sort (id, items, notes). */
  sortKey?: string;
  render: (row: SearchRow) => string;
}

const COLUMNS: ColumnDef[] = [
  { key: "id", label: "ID", sortKey: "id", render: (r) => formatCell(r.id) },
  { key: "customer", label: "Customer", sortKey: "customer", render: renderCustomer },
  { key: "items", label: "Items", numeric: true, render: renderItems },
  { key: "total", label: "Total", numeric: true, sortKey: "total", render: renderTotal },
  { key: "notes", label: "Notes", render: (r) => formatCell(r.notes) },
  { key: "placedAt", label: "Placed", sortKey: "placedAt", render: renderDate },
];

type PageItem = number | "left-ellipsis" | "right-ellipsis";

/** Windowed page list with ellipses: 1 … 4 [5] 6 … N. */
function getPageItems(current: number, total: number): PageItem[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const sibling = 1;
  const left = Math.max(current - sibling, 1);
  const right = Math.min(current + sibling, total);
  const items: PageItem[] = [1];
  if (left > 2) items.push("left-ellipsis");
  for (let i = Math.max(left, 2); i <= Math.min(right, total - 1); i++) {
    items.push(i);
  }
  if (right < total - 1) items.push("right-ellipsis");
  items.push(total);
  return items;
}

export default function SearchTable({
  refreshSignal = 0,
  endpoint = "/api/orders",
  pageSize = 20,
  filters,
  onRows,
  highlightId,
  highlightKey,
  onQueryChange,
  controlledResponse,
  controlledLoading = false,
  controlledError = null,
  onRequestStateChange,
}: SearchTableProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [approximate, setApproximate] = useState(false);
  const [sort, setSort] = useState<string>("placedAt");
  const [dir, setDir] = useState<SortDir>("desc");
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Row currently playing the new-order flash (cleared after the animation).
  const [flashId, setFlashId] = useState<string | number | null>(null);
  // First-row id that just changed (drives the `data-new` entry animation).
  const [newFirstId, setNewFirstId] = useState<string | number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const isControlled = onRequestStateChange != null;

  // Latest onRows without making it a fetch dependency.
  const onRowsRef = useRef(onRows);
  useEffect(() => {
    onRowsRef.current = onRows;
  });

  const fetchPage = useCallback(
    async (
      q: string,
      p: number,
      sortCol: string,
      sortDir: SortDir,
      f: OrderFilters | undefined,
      showSearchIndicator: boolean,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setSearchLoading(showSearchIndicator);
      setError(null);
      try {
        const params = new URLSearchParams({
          q,
          page: String(p),
          pageSize: String(pageSize),
        });
        if (sortCol) {
          params.set("sort", sortCol);
          params.set("dir", sortDir);
        }
        appendFilterParams(params, f);
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: SearchResponse = await res.json();
        // An aborted controller doesn't guarantee its fetch promise rejects
        // before a newer, faster request's promise resolves — without this
        // guard, a slower stale response can land after and silently
        // overwrite the correct state from the request that superseded it.
        if (abortRef.current !== controller) return;
        const data = Array.isArray(json.data) ? json.data : [];
        setRows(data);
        setTotalPages(Math.max(1, json.totalPages ?? 1));
        setTotal(json.total ?? 0);
        setApproximate(Boolean(json.approximate));
        onRowsRef.current?.(data);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (abortRef.current !== controller) return;
        setError((err as Error).message);
        setRows([]);
        setTotalPages(1);
        setTotal(0);
        setApproximate(false);
      } finally {
        if (abortRef.current === controller) {
          setLoading(false);
          setSearchLoading(false);
        }
      }
    },
    [endpoint, pageSize],
  );

  // Search commits on Enter only (Task 19) — typing updates the input value but
  // does NOT fetch. The Enter handler (and clear+Enter) is the sole path that
  // sets `debouncedQuery`, which drives both the list fetch below and the
  // parent's chart aggregates via onQueryChange. No as-you-type timer.

  // Notify the parent of the active (committed) query so the chart can narrow
  // its aggregates to the same matching set.
  useEffect(() => {
    onQueryChange?.(debouncedQuery);
  }, [debouncedQuery, onQueryChange]);

  useEffect(() => {
    if (!isControlled) return;
    if (!controlledResponse) return;
    const data = Array.isArray(controlledResponse.data)
      ? controlledResponse.data
      : [];
    // Controlled data is supplied by the parent after one combined dashboard fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(data);
    setTotalPages(Math.max(1, controlledResponse.totalPages ?? 1));
    setTotal(controlledResponse.total ?? 0);
    setApproximate(Boolean(controlledResponse.approximate));
    setError(null);
    onRowsRef.current?.(data);
  }, [controlledResponse, isControlled]);

  useEffect(() => {
    if (!isControlled) return;
    // Controlled errors mirror the parent combined request state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(controlledError);
    if (!controlledError) return;
    setRows([]);
    setTotalPages(1);
    setTotal(0);
    setApproximate(false);
  }, [controlledError, isControlled]);

  // Single source of truth for fetching: reacts to query, page, sort, filters,
  // and the SSE refresh signal. Sorting/paging/filtering are all server-side.
  // When filters change we snap back to page 1 first (skipping a redundant
  // fetch at the old page).
  const lastFiltersKey = useRef<string>(JSON.stringify(filters ?? {}));
  const lastFetchedQuery = useRef(debouncedQuery);
  useEffect(() => {
    const key = JSON.stringify(filters ?? {});
    if (key !== lastFiltersKey.current) {
      lastFiltersKey.current = key;
      if (page !== 1) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPage(1);
        return; // re-runs with page 1
      }
    }
    const queryChanged = debouncedQuery !== lastFetchedQuery.current;
    lastFetchedQuery.current = debouncedQuery;
    if (isControlled) {
      onRequestStateChange?.({
        q: debouncedQuery,
        page,
        pageSize,
        sort,
        dir,
      });
      return;
    }
    // Kicks off an async fetch (which toggles loading state); intentional.
    fetchPage(debouncedQuery, page, sort, dir, filters, queryChanged);
  }, [
    debouncedQuery,
    page,
    pageSize,
    sort,
    dir,
    filters,
    refreshSignal,
    fetchPage,
    isControlled,
    onRequestStateChange,
  ]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // When a new order event arrives (highlightKey bumps), flash its row once it
  // shows up in the freshly-fetched rows. The row may land a tick after the
  // event, so this also re-checks whenever `rows` updates.
  const lastFlashKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (highlightKey == null || highlightId == null) return;
    if (highlightKey === lastFlashKey.current) return;
    const present = rows.some((r) => String(r.id) === String(highlightId));
    if (!present) return;
    lastFlashKey.current = highlightKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlashId(highlightId);
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [rows, highlightKey, highlightId]);

  // Mark the first row as "new" only for an explicit new-order event. Pagination
  // also changes the first row id, so the SSE/quick-add highlight key is the
  // guard that keeps normal page changes from replaying the entry animation.
  const lastNewFirstKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (highlightKey == null || highlightId == null) return;
    if (highlightKey === lastNewFirstKey.current) return;
    const firstId = rows[0]?.id as string | number | undefined;
    if (firstId == null) return;
    if (String(firstId) !== String(highlightId)) return;
    lastNewFirstKey.current = highlightKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNewFirstId(firstId);
    const t = setTimeout(() => setNewFirstId(null), 600);
    return () => clearTimeout(t);
  }, [rows, highlightKey, highlightId]);

  const toggleSort = useCallback(
    (sortKey: string) => {
      if (sort === sortKey) {
        setDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSort(sortKey);
        setDir("asc");
      }
      setPage(1);
    },
    [sort],
  );

  const goToPage = useCallback(
    (n: number) => {
      const clamped = Math.min(Math.max(n, 1), totalPages);
      setPage(clamped);
    },
    [totalPages],
  );

  const pageItems = useMemo(
    () => getPageItems(page, totalPages),
    [page, totalPages],
  );

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Search</h2>
        {(isControlled ? controlledLoading : loading) && (
          <span className="text-xs text-indigo-500" aria-live="polite">
            {searchLoading ? "searching…" : "updating…"}
          </span>
        )}
      </header>

      <input
        data-testid="search-input"
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value === "") {
            setDebouncedQuery("");
            setPage(1);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Commit the search: list + aggregates repaint. Also the clear+Enter
            // path — an emptied input commits "" and restores the full list.
            setDebouncedQuery(query);
            setPage(1);
          }
        }}
        placeholder="Search records…"
        className="mb-3 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
        aria-label="Search records"
      />

      <div
        className="overflow-x-auto"
        style={{ minHeight: (pageSize + 1) * 41 }}
      >
        {error ? (
          <div className="py-10 text-center text-sm text-red-500">
            Search failed: {error}
          </div>
        ) : rows.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-gray-400"
            aria-live="polite"
          >
            {(isControlled ? controlledLoading : loading) ? (
              <>
                <span
                  aria-hidden
                  className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-500 dark:border-gray-700 dark:border-t-indigo-400"
                />
                <span className={searchLoading ? "animate-pulse" : undefined}>
                  {(isControlled ? controlledLoading : searchLoading)
                    ? "Searching…"
                    : "Loading…"}
                </span>
              </>
            ) : (
              "No results."
            )}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left dark:border-gray-800">
                {COLUMNS.map((col) => {
                  const isSorted = col.sortKey ? sort === col.sortKey : false;
                  const sortable = !!col.sortKey;
                  return (
                    <th
                      key={col.key}
                      {...(sortable
                        ? { "data-testid": `sort-${col.sortKey}` }
                        : {})}
                      onClick={
                        sortable ? () => toggleSort(col.sortKey!) : undefined
                      }
                      aria-sort={
                        isSorted
                          ? dir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      className={cn(
                        "px-3 py-2 font-medium text-gray-500 dark:text-gray-400",
                        sortable &&
                          "cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200",
                        col.numeric && "text-right",
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {sortable && (
                          <span
                            aria-hidden
                            className={cn(
                              "text-xs",
                              isSorted
                                ? "text-indigo-500"
                                : "text-transparent",
                            )}
                          >
                            {isSorted ? (dir === "asc" ? "▲" : "▼") : "▲"}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={(row.id as string | number | undefined) ?? i}
                  data-testid="search-result"
                  data-id={row.id as string | number | undefined}
                  data-order-id={row.id as string | number | undefined}
                  data-new={
                    i === 0 &&
                    newFirstId != null &&
                    String(row.id) === String(newFirstId)
                      ? "true"
                      : undefined
                  }
                  className={cn(
                    "border-b border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50",
                    flashId != null &&
                      String(row.id) === String(flashId) &&
                      "row-insert",
                  )}
                >
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2 align-top",
                        col.numeric && "text-right tabular-nums",
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Page {page} of {totalPages} ·{" "}
          <span data-testid="search-total" data-total={total}>
            {approximate ? `${total.toLocaleString()}+` : total.toLocaleString()}
          </span>{" "}
          results
        </span>

        {totalPages > 1 && (
          <nav aria-label="Pagination">
            <ul className="flex items-center gap-1">
              <li>
                <button
                  type="button"
                  data-testid="prev-page"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1 || (isControlled ? controlledLoading : loading)}
                  className="flex h-9 items-center rounded-md border border-gray-300 px-3 text-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  Prev
                </button>
              </li>

              {pageItems.map((item) => {
                if (item === "left-ellipsis" || item === "right-ellipsis") {
                  return (
                    <li
                      key={item}
                      aria-hidden
                      className="px-2 text-sm text-gray-400"
                    >
                      …
                    </li>
                  );
                }
                const isActive = item === page;
                return (
                  <li key={item} data-testid={`page-${item}`}>
                    <button
                      type="button"
                      onClick={() => goToPage(item)}
                      aria-current={isActive ? "page" : undefined}
                      data-testid={isActive ? "current-page" : undefined}
                      className={cn(
                        "flex h-9 min-w-9 items-center justify-center rounded-md px-3 text-sm transition-colors",
                        isActive
                          ? "bg-indigo-600 text-white"
                          : "border border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800",
                      )}
                    >
                      {item}
                    </button>
                  </li>
                );
              })}

              <li>
                <button
                  type="button"
                  data-testid="next-page"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages || (isControlled ? controlledLoading : loading)}
                  className="flex h-9 items-center rounded-md border border-gray-300 px-3 text-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  Next
                </button>
              </li>
            </ul>
          </nav>
        )}
      </footer>
    </section>
  );
}
