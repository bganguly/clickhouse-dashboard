/**
 * ClickHouse DDL — idempotent (IF NOT EXISTS everywhere).
 *
 * Raw tables:
 *   categories, regions, customers, products  — MergeTree, one-time seeded
 *   orders, order_items                        — MergeTree, insert-only
 *   order_category_facts                       — MergeTree, one row per (orderId, categoryId)
 *                                                Written by createOrder; source for all MVs.
 *
 * Aggregate tables (SummingMergeTree) + Materialized Views:
 *   daily_summary                  ← mv_daily_summary
 *   daily_filter_category_summary  ← mv_daily_filter_category_summary
 *   daily_status_category_summary  ← mv_daily_status_category_summary
 *   daily_customer_category_summary← mv_daily_customer_category_summary
 *
 * All MVs read from order_category_facts so the app only needs one write
 * path — no aggregates-worker, no outbox, no LISTEN/NOTIFY.
 */

export const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS categories (
    categoryId UInt32,
    name       LowCardinality(String),
    slug       LowCardinality(String),
    parentId   Nullable(UInt32),
    createdAt  DateTime64(3, 'UTC')
  ) ENGINE = MergeTree() ORDER BY categoryId`,

  `CREATE TABLE IF NOT EXISTS regions (
    regionId  UInt32,
    code      LowCardinality(String),
    name      String,
    country   String,
    timezone  String
  ) ENGINE = MergeTree() ORDER BY regionId`,

  `CREATE TABLE IF NOT EXISTS customers (
    customerId UInt64,
    email      String,
    firstName  String,
    lastName   String,
    phone      Nullable(String),
    regionId   UInt32,
    createdAt  DateTime64(3, 'UTC')
  ) ENGINE = MergeTree()
  ORDER BY customerId`,

  `CREATE TABLE IF NOT EXISTS products (
    productId   UInt32,
    sku         String,
    name        String,
    description Nullable(String),
    price       Decimal(10,2),
    cost        Decimal(10,2),
    stock       UInt32,
    categoryId  UInt32,
    createdAt   DateTime64(3, 'UTC')
  ) ENGINE = MergeTree() ORDER BY productId`,

  `CREATE TABLE IF NOT EXISTS orders (
    orderId           UInt64,
    customerId        UInt64,
    regionId          UInt32,
    regionCode        LowCardinality(String),
    customerFirstName String,
    customerLastName  String,
    customerEmail     String,
    status            LowCardinality(String),
    total             Decimal(12,2),
    currency          LowCardinality(String),
    notes             Nullable(String),
    searchText        String,
    placedAt          DateTime64(3, 'UTC')
  ) ENGINE = MergeTree()
  ORDER BY (toDate(placedAt), orderId)`,

  `CREATE TABLE IF NOT EXISTS order_items (
    itemId       UInt64,
    orderId      UInt64,
    productId    UInt32,
    productName  String,
    productSku   LowCardinality(String),
    categoryId   UInt32,
    categoryName LowCardinality(String),
    quantity     UInt32,
    unitPrice    Decimal(10,2),
    discount     Decimal(5,2)
  ) ENGINE = MergeTree()
  ORDER BY (orderId, itemId)`,

  `CREATE TABLE IF NOT EXISTS order_category_facts (
    orderId      UInt64,
    date         Date,
    placedAt     DateTime64(3, 'UTC'),
    customerId   UInt64,
    regionId     UInt32,
    regionCode   LowCardinality(String),
    status       LowCardinality(String),
    orderTotal   Decimal(12,2),
    categoryId   UInt32,
    categoryName LowCardinality(String),
    totalItems   UInt32,
    totalRevenue Decimal(14,2)
  ) ENGINE = MergeTree()
  ORDER BY (date, orderId, categoryId)`,

  `CREATE TABLE IF NOT EXISTS daily_summary (
    date         Date,
    categoryId   UInt32,
    categoryName LowCardinality(String),
    regionId     UInt32,
    regionCode   LowCardinality(String),
    totalOrders  UInt64,
    totalRevenue Decimal(14,2),
    totalItems   UInt64
  ) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems))
  ORDER BY (date, regionId, categoryId)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_summary
  TO daily_summary AS
  SELECT
    date,
    categoryId,
    categoryName,
    regionId,
    regionCode,
    toUInt64(1)          AS totalOrders,
    totalRevenue,
    toUInt64(totalItems) AS totalItems
  FROM order_category_facts`,

  `CREATE TABLE IF NOT EXISTS daily_filter_category_summary (
    date         Date,
    regionId     UInt32,
    regionCode   LowCardinality(String),
    status       LowCardinality(String),
    categoryId   UInt32,
    categoryName LowCardinality(String),
    totalOrders  UInt64,
    totalRevenue Decimal(14,2),
    totalItems   UInt64
  ) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems))
  ORDER BY (date, regionId, status, categoryId)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_filter_category_summary
  TO daily_filter_category_summary AS
  SELECT
    date,
    regionId,
    regionCode,
    status,
    categoryId,
    categoryName,
    toUInt64(1)          AS totalOrders,
    totalRevenue,
    toUInt64(totalItems) AS totalItems
  FROM order_category_facts`,

  `CREATE TABLE IF NOT EXISTS daily_status_category_summary (
    date         Date,
    status       LowCardinality(String),
    categoryId   UInt32,
    categoryName LowCardinality(String),
    totalOrders  UInt64,
    totalRevenue Decimal(14,2),
    totalItems   UInt64
  ) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems))
  ORDER BY (date, status, categoryId)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_status_category_summary
  TO daily_status_category_summary AS
  SELECT
    date,
    status,
    categoryId,
    categoryName,
    toUInt64(1)          AS totalOrders,
    totalRevenue,
    toUInt64(totalItems) AS totalItems
  FROM order_category_facts`,

  `CREATE TABLE IF NOT EXISTS daily_customer_category_summary (
    date         Date,
    customerId   UInt64,
    regionId     UInt32,
    regionCode   LowCardinality(String),
    status       LowCardinality(String),
    categoryId   UInt32,
    categoryName LowCardinality(String),
    totalOrders  UInt64,
    totalRevenue Decimal(14,2),
    totalItems   UInt64
  ) ENGINE = SummingMergeTree((totalOrders, totalRevenue, totalItems))
  ORDER BY (date, customerId, regionId, status, categoryId)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_customer_category_summary
  TO daily_customer_category_summary AS
  SELECT
    date,
    customerId,
    regionId,
    regionCode,
    status,
    categoryId,
    categoryName,
    toUInt64(1)          AS totalOrders,
    totalRevenue,
    toUInt64(totalItems) AS totalItems
  FROM order_category_facts`,
];

export async function runMigrations(): Promise<void> {
  const { execute } = await import("./clickhouse");
  for (const stmt of DDL_STATEMENTS) {
    await execute(stmt);
  }
}
