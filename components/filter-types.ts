export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface RegionOption {
  code: string;
  name: string;
}

export interface OrderFilters {
  status: string[];
  regionCodes: string[];
  from: string;
  to: string;
  totalMin: string;
  totalMax: string;
}

export const EMPTY_FILTERS: OrderFilters = {
  status: [],
  regionCodes: [],
  from: "",
  to: "",
  totalMin: "",
  totalMax: "",
};

export function appendFilterParams(
  params: URLSearchParams,
  f?: OrderFilters,
): void {
  if (!f) return;
  if (f.status.length) params.set("status", f.status.join(","));
  if (f.regionCodes.length) params.set("regionCode", f.regionCodes.join(","));
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.totalMin) params.set("minTotal", f.totalMin);
  if (f.totalMax) params.set("maxTotal", f.totalMax);
}

export function isEmptyFilters(f: OrderFilters): boolean {
  return (
    f.status.length === 0 &&
    f.regionCodes.length === 0 &&
    !f.from &&
    !f.to &&
    !f.totalMin &&
    !f.totalMax
  );
}
