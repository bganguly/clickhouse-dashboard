/**
 * Shared, framework- and Prisma-agnostic types used across the service layer
 * and the route handlers. Nothing here may import from "@prisma/client".
 */

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED"
  | "REFUNDED";

// ---------- Shared summaries ----------

export interface CustomerSummary {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
}

export interface RegionSummary {
  id: number;
  code: string;
  name: string;
}

/** Lightweight region entry for filter dropdowns (GET /api/regions). */
export interface RegionOption {
  id: number;
  code: string;
  name: string;
}

export interface ProductSummary {
  id: number;
  sku: string;
  name: string;
}

// ---------- Orders ----------

export interface OrderItemDTO {
  id: number;
  productId: number;
  quantity: number;
  unitPrice: number;
  discount: number;
  product?: ProductSummary;
}

export interface OrderDTO {
  id: number;
  status: OrderStatus;
  total: number;
  currency: string;
  notes: string | null;
  placedAt: string;
  customer: CustomerSummary;
  region: RegionSummary;
  items: OrderItemDTO[];
}

export type SortDir = "asc" | "desc";

/** Fields the orders list may be sorted by (server-side only). */
export type OrderSortField = "placedAt" | "total" | "status" | "customer" | "id";

/** Filters that narrow the orders list. All combine (AND) with `q`, sort, paging. */
export interface OrderFilterInput {
  /** OrderStatus value(s); accepts a comma-separated list. */
  status?: string | null;
  /** Region code(s); accepts a comma-separated list. */
  regionCode?: string | null;
  /** Inclusive placedAt lower bound (ISO date or datetime). */
  from?: string | null;
  /** Inclusive placedAt upper bound (date-only is treated as end-of-day). */
  to?: string | null;
  /** Inclusive total lower/upper bounds. */
  minTotal?: number | null;
  maxTotal?: number | null;
}

export interface OrderListInput extends OrderFilterInput {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Rows per page. Defaults to 20, capped at 100. */
  pageSize?: number;
  /** Free-text search over customer name/email and order notes. */
  q?: string | null;
  /** Sort field; validated server-side, defaults to "placedAt". */
  sort?: string | null;
  /** Sort direction; validated server-side, defaults to "desc". */
  dir?: string | null;
  /** When true, also compute sidebar facet counts for the current filter. */
  facets?: boolean;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface OrderFacets {
  /** Counts per order status for the current filter. */
  status: FacetCount[];
  /** Counts per region code for the current filter. */
  region: FacetCount[];
  /** True when the facet counts were capped (broad result set). */
  approximate: boolean;
}

export interface OrderListResult {
  data: OrderDTO[];
  page: number;
  pageSize: number;
  /** Matching rows. Capped (and `approximate: true`) for broad searches. */
  total: number;
  totalPages: number;
  /** True when `total`/`totalPages` are a capped estimate (broad result set). */
  approximate: boolean;
  /** Present only when `facets` was requested. */
  facets?: OrderFacets;
}

export interface CreateOrderItemInput {
  productId: number;
  quantity: number;
  unitPrice: number;
  discount?: number;
}

export interface CreateOrderInput {
  customerId: number;
  regionId: number;
  currency?: string;
  notes?: string | null;
  items: CreateOrderItemInput[];
}

export interface CreateOrderResult {
  id: number;
  status: string;
  total: number;
  placedAt: string;
}

// ---------- Aggregates ----------

/**
 * Aggregates honor the same filter set as GET /api/orders (status, regionCode
 * comma-lists, placedAt range via from/to, minTotal/maxTotal). `from`/`to` are
 * required here and double as the daily date range.
 */
export interface AggregateQueryInput extends OrderFilterInput {
  from: string;
  to: string;
  /** Free-text search over customer name/email and order notes (ILIKE). */
  q?: string | null;
  /** Keep only the top-N categories by revenue per day; rest roll into "Others". */
  topCategories?: number | null;
}

export interface CategoryAggregate {
  totalOrders: number;
  totalRevenue: number;
  totalItems: number;
  avgOrderValue: number;
}

export interface DailyAggregate {
  date: string;
  categories: Record<string, CategoryAggregate>;
  totals: { totalOrders: number; totalRevenue: number; totalItems: number };
}

// ---------- Customers ----------

export interface CustomerDTO {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  region: RegionSummary;
  createdAt: string;
}

export interface CustomerListInput {
  cursor?: number | null;
  limit?: number;
  q?: string | null;
  regionId?: number | null;
}

export interface CustomerListResult {
  data: CustomerDTO[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface CreateCustomerInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  regionId: number;
}

// ---------- Products ----------

export interface ProductDTO {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  price: number;
  cost: number;
  stock: number;
  categoryId: number;
  categoryName?: string;
}

export interface ProductListInput {
  cursor?: number | null;
  limit?: number;
  q?: string | null;
  categoryId?: number | null;
}

export interface ProductListResult {
  data: ProductDTO[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  cost: number;
  stock?: number;
  categoryId: number;
}

// ---------- Search ----------

export type SearchEntityType = "order" | "product" | "customer" | (string & {});

export interface SearchInput {
  q: string;
  entityType?: SearchEntityType | null;
  limit?: number;
}

export interface SearchResultItem {
  entityType: string;
  entityId: number;
  content: string;
}

export interface SearchResult {
  query: string;
  results: SearchResultItem[];
}

// ---------- Stream ----------

export interface OrderNotification {
  id: number;
  total: number;
  customerId: number;
  customerEmail?: string;
  regionCode?: string;
  placedAt: string;
  categorySlug?: string;
}

export type StreamEventName = "connected" | "order" | "heartbeat" | "error";
