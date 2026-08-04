# API Contract

Single source of truth for the backend HTTP API. The frontend and the
end-to-end tests both code against the shapes below. Canonical endpoint names —
do not rename: `/api/orders`, `/api/aggregates`, `/api/stream`.

All responses are JSON unless noted (`/api/stream` is SSE). All `total`/money
fields are JSON **numbers** (not strings); dates are ISO-8601 strings.

## Conventions

### Error envelope

Any non-2xx response uses:

```json
{ "error": "human readable message", "code": "BAD_REQUEST", "details": { } }
```

`details` is optional. `code` is one of:

| code          | HTTP |
| ------------- | ---- |
| `BAD_REQUEST` | 400  |
| `VALIDATION`  | 422  |
| `NOT_FOUND`   | 404  |
| `CONFLICT`    | 409  |
| `DB_ERROR`    | 500  |
| `INTERNAL`    | 500  |

### Shared objects

```ts
Customer = { id: number; email: string; firstName: string; lastName: string }
Region   = { id: number; code: string; name: string }
Product  = { id: number; sku: string; name: string }

OrderItem = {
  id: number; productId: number; quantity: number;
  unitPrice: number; discount: number; product?: Product
}

Order = {
  id: number;
  status: "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED"
        | "DELIVERED" | "CANCELLED" | "REFUNDED";
  total: number;
  currency: string;          // e.g. "USD"
  notes: string | null;
  placedAt: string;          // ISO-8601
  customer: Customer;
  region: Region;
  items: OrderItem[];
}
```

---

## GET /api/orders

Numbered pagination + server-side sort + search. Sorting and paging are **server
side only**; the client never re-sorts.

### Query parameters

| param        | type   | default    | notes                                                                                     |
| ------------ | ------ | ---------- | ----------------------------------------------------------------------------------------- |
| `page`       | number | `1`        | 1-based. Values `< 1` clamp to 1.                                                          |
| `pageSize`   | number | `20`       | Clamped to `1..100`.                                                                       |
| `q`          | string | —          | Case-insensitive search over customer first/last name, customer email, and order notes.   |
| `sort`       | string | `placedAt` | One of `placedAt \| total \| status \| customer`. Unknown values fall back to `placedAt`. |
| `dir`        | string | `desc`     | `asc \| desc`. Unknown values fall back to `desc`.                                         |
| `status`     | string | —          | Filter by `OrderStatus`. Comma-separated list ok. Unknown values are ignored.             |
| `regionCode` | string | —          | Filter by region code. Comma-separated list ok.                                           |
| `from`       | string | —          | Inclusive `placedAt` lower bound (`YYYY-MM-DD` or ISO datetime).                           |
| `to`         | string | —          | Inclusive `placedAt` upper bound. Date-only is treated as end-of-day.                      |
| `minTotal`   | number | —          | Inclusive lower bound on `total`.                                                         |
| `maxTotal`   | number | —          | Inclusive upper bound on `total`.                                                         |
| `facets`     | `1`    | —          | When `1`/`true`, include `facets` in the response.                                        |

`sort=customer` orders by `customer.lastName`. All sorts add `id` as a
tie-breaker so pages are stable. Filters combine (AND) with `q`, sort, and
pagination. Malformed `from`/`to`/`minTotal`/`maxTotal` return `400 BAD_REQUEST`.

Frontend call shape:

```
GET /api/orders?q=&page=1&pageSize=20&sort=placedAt&dir=desc&status=&regionCode=&from=&to=&minTotal=&maxTotal=
```

### 200 response

```json
{
  "data": [ /* Order[] */ ],
  "page": 1,
  "pageSize": 20,
  "total": 4000000,
  "totalPages": 200000,
  "approximate": false,
  "facets": {
    "status": [ { "value": "DELIVERED", "count": 812345 } ],
    "region": [ { "value": "R001", "count": 41234 } ],
    "approximate": true
  }
}
```

- `total` — count of rows matching the filters/`q` (the full set, not the page).
- `approximate` — `true` when the result is broad and `total`/`totalPages` are a
  capped estimate (capped at `10000`). The page data is always exact.
- `totalPages` — `ceil(total / pageSize)`; `0` when `total` is `0`.
- `data.length` ≤ `pageSize`. An out-of-range `page` returns an empty `data`.
- `facets` — present only when `facets=1`. `status`/`region` are
  `{ value, count }[]` (region `value` is the region code), each sorted by count
  descending. `facets.approximate` is `true` when the facet counts were capped.

## POST /api/orders

Creates a single order with its items.

### Request body

```json
{
  "customerId": 1,
  "regionId": 1,
  "currency": "USD",
  "notes": "optional",
  "items": [
    { "productId": 10, "quantity": 2, "unitPrice": 19.99, "discount": 0 }
  ]
}
```

`currency` defaults to `"USD"`, `notes` to `null`, `discount` to `0`. `total` is
computed server-side as `Σ quantity × unitPrice × (1 − discount)`.

### 201 response

A single `Order` (same shape as items in `GET /api/orders`). Validation failures
return `400 BAD_REQUEST`.

---

## GET /api/aggregates

Daily totals grouped by category, computed over the **filtered** order set. The
filter parameters mirror `GET /api/orders` exactly (same WHERE semantics), so the
chart and the table can share one filter bar.

### Query parameters

| param           | type   | required | notes                                                                                      |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `from`          | string | yes      | `YYYY-MM-DD` (inclusive). Doubles as the `placedAt` lower bound.                            |
| `to`            | string | yes      | `YYYY-MM-DD` (inclusive). Date-only is treated as end-of-day.                               |
| `status`        | string | no       | Filter by `OrderStatus`. Comma-separated list ok. Unknown values are ignored.              |
| `regionCode`    | string | no       | Filter by region code. **Comma-separated list ok** (was single).                           |
| `minTotal`      | number | no       | Inclusive lower bound on order `total`.                                                     |
| `maxTotal`      | number | no       | Inclusive upper bound on order `total`.                                                     |
| `topCategories` | number | no       | Keep top-N categories/day by revenue (default `5`); the rest roll into an `"Others"` bucket. |

Missing/invalid dates return `400 BAD_REQUEST`. All filters combine (AND) and
narrow the orders that feed the daily category buckets — category revenue/items
come from the line items of the matching orders.

`topCategories` caps each day's `categories` map to at most **N+1** keys: only the
N highest-revenue categories are kept by name, and a single `"Others"` entry holds
the summed `totalOrders`/`totalRevenue`/`totalItems` (with `avgOrderValue`
recomputed) of the remainder. `"Others"` is the literal, stable rollup key.
Day-level `totals` are unchanged (they reflect every category). No `"Others"` key
is added when a day has ≤ N categories.

### 200 response

```json
{
  "data": [
    {
      "date": "2026-01-01",
      "categories": {
        "Electronics": { "totalOrders": 12, "totalRevenue": 5400.5, "totalItems": 30, "avgOrderValue": 450.04 }
      },
      "totals": { "totalOrders": 12, "totalRevenue": 5400.5, "totalItems": 30 }
    }
  ]
}
```

- `categories` is keyed by category name; each value is
  `{ totalOrders, totalRevenue, totalItems, avgOrderValue }`.
- `totals` is the per-day sum across categories (no `avgOrderValue`).
- `data` is ordered by `date` ascending.

---

## GET /api/regions

The full region list for populating the region filter dropdown (independent of
any current filter/page). Ordered by name.

### 200 response

```json
[
  { "code": "R001", "name": "Andes" },
  { "code": "R014", "name": "Baltics" }
]
```

A bare array of `{ code, name }`. The frontend falls back to page-discovered
codes if this endpoint is unavailable.

---

## GET /api/stream

Server-Sent Events backed by an in-process Node.js `EventEmitter` (no database
polling). `Content-Type: text/event-stream`.

### Events

| event       | data                                                    | when                       |
| ----------- | ------------------------------------------------------- | -------------------------- |
| `connected` | `{ "ts": "<ISO>" }`                                      | once, on subscribe         |
| `order`     | `OrderNotification`                                      | on each new order NOTIFY   |
| `heartbeat` | `{ "ts": "<ISO>" }`                                      | every 25s, keep-alive      |
| `error`     | `{ "message": string, "code"?: string }`                | on failure (stream closes) |

```ts
OrderNotification = {
  id: number; total: number; customerId: number;
  customerEmail?: string; regionCode?: string; placedAt: string; // ISO
}
```

Wire format example:

```
event: order
data: {"id":4242,"total":99.5,"customerId":7,"regionCode":"R001","placedAt":"2026-06-22T06:05:46.972Z"}
```
