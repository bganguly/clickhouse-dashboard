import { AppError } from "@/lib/errors";

export const COUNT_SENTINEL = 10_001;

export const ORDER_STATUSES: readonly string[] = [
  "PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED",
];

export const SORT_COL: Record<string, string> = {
  placedAt: "placedAt",
  total: "total",
  status: "status",
  customer: "customerLastName",
  id: "orderId",
};

export function normalizeSort(sort: string | null | undefined): string {
  return sort != null && sort in SORT_COL ? sort : "placedAt";
}

export function normalizeDir(dir: string | null | undefined): "asc" | "desc" {
  return dir === "asc" || dir === "desc" ? dir : "desc";
}

export function escapeLike(input: string): string {
  return input.replace(/'/g, "''");
}

export function normalizeStatusList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => ORDER_STATUSES.includes(s));
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ResolvedFilters {
  statuses: string[];
  regionCodes: string[];
  from: string | null;
  to: string | null;
  minTotal: number | null;
  maxTotal: number | null;
  hasAny: boolean;
}

export function parseList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseDateBoundary(value: string | null | undefined, edge: "start" | "end"): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError("BAD_REQUEST", `invalid date filter: ${value}`);
  if (edge === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    d.setUTCHours(23, 59, 59, 999);
    return d.toISOString().replace("T", " ").replace("Z", "");
  }
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export async function resolveFilters(input: {
  status?: string | null;
  regionCode?: string | null;
  from?: string | null;
  to?: string | null;
  minTotal?: number | null;
  maxTotal?: number | null;
}): Promise<ResolvedFilters> {
  const statuses = normalizeStatusList(input.status);
  const regionCodes = parseList(input.regionCode);
  const from = parseDateBoundary(input.from, "start");
  const toRaw = input.to || (input.from ? todayDateString() : input.to);
  const to = parseDateBoundary(toRaw, "end");
  const minTotal = input.minTotal ?? null;
  const maxTotal = input.maxTotal ?? null;
  const hasAny =
    statuses.length > 0 || regionCodes.length > 0 || from !== null || to !== null ||
    minTotal !== null || maxTotal !== null;
  return { statuses, regionCodes, from, to, minTotal, maxTotal, hasAny };
}

export function buildWhereParts(
  searchTokens: string[],
  f: ResolvedFilters,
): { clauses: string[]; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  let pi = 0;
  for (const tok of searchTokens) {
    const k = `stok${pi++}`;
    clauses.push(`hasToken(searchText, {${k}: String})`);
    params[k] = tok.toLowerCase();
  }
  if (f.statuses.length) {
    clauses.push(`status IN ({statuses: Array(String)})`);
    params["statuses"] = f.statuses;
  }
  if (f.regionCodes.length) {
    clauses.push(`regionCode IN ({regionCodes: Array(String)})`);
    params["regionCodes"] = f.regionCodes;
  }
  if (f.from) {
    clauses.push(`placedAt >= {from: DateTime64(3)}`);
    params["from"] = f.from;
  }
  if (f.to) {
    clauses.push(`placedAt <= {to: DateTime64(3)}`);
    params["to"] = f.to;
  }
  if (f.minTotal !== null) {
    clauses.push(`total >= {minTotal: Float64}`);
    params["minTotal"] = f.minTotal;
  }
  if (f.maxTotal !== null) {
    clauses.push(`total <= {maxTotal: Float64}`);
    params["maxTotal"] = f.maxTotal;
  }
  return { clauses, params };
}

export function whereSQL(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export const NOTES_POOL = [
  "please leave at front door ring bell twice",
  "gift wrapping requested include birthday card",
  "fragile items handle with extreme care",
  "corporate bulk order for quarterly offsite event",
  "express shipping required before the conference",
  "leave with building concierge if not home",
  "signature required upon delivery no exceptions",
  "urgent replacement for previously damaged shipment",
  "perishable contents keep refrigerated at all times",
  "eco friendly packaging only no plastic wrap",
  "annual office supply subscription renewal invoice",
  "school supply order for upcoming fall semester",
  "bridal shower gift please include congratulations card",
  "rush order needed before saturday morning delivery",
  "holiday promotional bundle seasonal discount applied",
  "wholesale distributor recurring weekly standing order",
  "loyalty rewards redemption free shipping included",
  "priority processing customer complaint credit applied",
  "temperature sensitive store below forty degrees fahrenheit",
  "military veteran discount applied thank you for service",
] as const;

export function pickNote(): string {
  return NOTES_POOL[Math.floor(Math.random() * NOTES_POOL.length)];
}

export function prefixTokens(word: string, minLen = 3): string {
  if (word.length < minLen) return "";
  const out: string[] = [];
  for (let i = minLen; i <= word.length; i++) {
    out.push(word.slice(0, i).toLowerCase());
  }
  return out.join(" ");
}

export function buildSearchText(
  firstName: string,
  lastName: string,
  orderId: number,
  notes?: string | null,
): string {
  const parts = [firstName.toLowerCase(), lastName.toLowerCase(), String(orderId)];
  if (notes) parts.push(notes);
  const prefs = [prefixTokens(firstName), prefixTokens(lastName)].filter(Boolean);
  if (prefs.length) parts.push(...prefs);
  return parts.join(" ");
}
