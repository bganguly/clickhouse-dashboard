import type { OrderFilters } from "./filter-types";

export type SearchRow = Record<string, unknown>;

export type SortDir = "asc" | "desc";

export interface SearchResponse {
  data: SearchRow[];
  page: number;
  totalPages: number;
  total: number;
  approximate?: boolean;
  countPending?: boolean;
}

export interface TableRequestState {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  dir: SortDir;
}

export interface SearchTableProps {
  refreshSignal?: number;
  endpoint?: string;
  pageSize?: number;
  filters?: OrderFilters;
  onRows?: (rows: SearchRow[]) => void;
  highlightId?: string | number;
  highlightKey?: number;
  onQueryChange?: (q: string) => void;
  controlledResponse?: SearchResponse | null;
  controlledLoading?: boolean;
  controlledError?: string | null;
  onRequestStateChange?: (state: TableRequestState) => void;
  externalTotal?: number | null;
  onCountChange?: (n: number) => void;
  onLoadingChange?: (loading: boolean) => void;
  onQueryMeta?: (info: { ms: number; source: string }) => void;
  onSearchStart?: () => void;
}

export function cn(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function formatCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export const moneyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function renderCustomer(row: SearchRow): string {
  const c = row.customer as
    | { firstName?: string; lastName?: string; email?: string }
    | undefined;
  if (!c) return "";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return name || c.email || "";
}

export function renderItems(row: SearchRow): string {
  const items = row.items;
  return Array.isArray(items) ? String(items.length) : "";
}

export function renderTotal(row: SearchRow): string {
  return typeof row.total === "number"
    ? moneyFmt.format(row.total)
    : formatCell(row.total);
}

export function renderDate(row: SearchRow): string {
  const v = row.placedAt;
  if (typeof v !== "string") return formatCell(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

export interface ColumnDef {
  key: string;
  label: string;
  numeric?: boolean;
  sortKey?: string;
  render: (row: SearchRow) => React.ReactNode;
  tdClassName?: string;
}

export const COLUMNS: ColumnDef[] = [
  { key: "id", label: "ID", sortKey: "id", render: (r) => formatCell(r.id) },
  { key: "customer", label: "Customer", sortKey: "customer", render: renderCustomer },
  { key: "items", label: "Items", numeric: true, render: renderItems },
  { key: "total", label: "Total", numeric: true, sortKey: "total", render: renderTotal },
  { key: "notes", label: "Notes", tdClassName: "max-w-[220px]", render: (r) => {
    const text = formatCell(r.notes);
    if (!text) return text;
    return <span className="block truncate" title={text}>{text}</span>;
  }},
  { key: "placedAt", label: "Placed", sortKey: "placedAt", render: renderDate },
];

export type PageItem = number | "left-ellipsis" | "right-ellipsis";

export function getPageItems(current: number, total: number): PageItem[] {
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
