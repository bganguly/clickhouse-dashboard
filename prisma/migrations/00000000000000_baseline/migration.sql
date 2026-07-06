-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "parentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regions" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "timezone" VARCHAR(50) NOT NULL,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "firstName" VARCHAR(100) NOT NULL,
    "lastName" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(30),
    "regionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "cost" DECIMAL(10,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "categoryId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "regionId" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "total" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "notes" TEXT,
    "search_text" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_category_facts" (
    "orderId" INTEGER NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "regionId" INTEGER,
    "regionCode" VARCHAR(10),
    "status" "OrderStatus",
    "orderTotal" DECIMAL(12,2),
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "order_category_facts_pkey" PRIMARY KEY ("orderId","categoryId")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "regionId" INTEGER NOT NULL,
    "regionCode" VARCHAR(10) NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "avgOrderValue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_filter_category_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "regionId" INTEGER NOT NULL,
    "regionCode" VARCHAR(10) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_filter_category_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_status_category_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_status_category_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_customer_category_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "customerId" INTEGER NOT NULL,
    "regionId" INTEGER NOT NULL,
    "regionCode" VARCHAR(10) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_customer_category_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_customer_token_category_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "regionId" INTEGER NOT NULL,
    "regionCode" VARCHAR(10) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_customer_token_category_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_customer_token_category_rollup" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_customer_token_category_rollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_customer_token_order_summary" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "regionId" INTEGER NOT NULL,
    "regionCode" VARCHAR(10) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_customer_token_order_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_index" (
    "id" SERIAL NOT NULL,
    "entityType" VARCHAR(50) NOT NULL,
    "entityId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_index_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" VARCHAR(128) NOT NULL,
    "userId" INTEGER NOT NULL,
    "data" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "entityType" VARCHAR(50) NOT NULL,
    "entityId" INTEGER NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "actorId" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "orderId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "count_cache" (
    "cache_key" TEXT NOT NULL,
    "total" BIGINT NOT NULL,
    "cached_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "count_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "regions_code_key" ON "regions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_regionId_idx" ON "customers"("regionId");

-- CreateIndex
CREATE INDEX "customers_email_idx" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_lastName_idx" ON "customers"("lastName");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");

-- CreateIndex
CREATE INDEX "products_sku_idx" ON "products"("sku");

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_customerId_placedAt_idx" ON "orders"("customerId", "placedAt");

-- CreateIndex
CREATE INDEX "orders_regionId_idx" ON "orders"("regionId");

-- CreateIndex
CREATE INDEX "orders_regionId_placedAt_idx" ON "orders"("regionId", "placedAt");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_status_placedAt_idx" ON "orders"("status", "placedAt");

-- CreateIndex
CREATE INDEX "orders_status_regionId_placedAt_idx" ON "orders"("status", "regionId", "placedAt");

-- CreateIndex
CREATE INDEX "orders_placedAt_idx" ON "orders"("placedAt");

-- CreateIndex
CREATE INDEX "orders_total_idx" ON "orders"("total");

-- CreateIndex
CREATE INDEX "orders_total_placedAt_idx" ON "orders"("total", "placedAt");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "order_category_facts_orderId_idx" ON "order_category_facts"("orderId");

-- CreateIndex
CREATE INDEX "order_category_facts_date_idx" ON "order_category_facts"("date");

-- CreateIndex
CREATE INDEX "order_category_facts_date_orderTotal_idx" ON "order_category_facts"("date", "orderTotal");

-- CreateIndex
CREATE INDEX "order_category_facts_date_orderTotal_categoryName_idx" ON "order_category_facts"("date", "orderTotal", "categoryName");

-- CreateIndex
CREATE INDEX "order_category_facts_status_date_orderTotal_idx" ON "order_category_facts"("status", "date", "orderTotal");

-- CreateIndex
CREATE INDEX "order_category_facts_status_date_orderTotal_categoryName_idx" ON "order_category_facts"("status", "date", "orderTotal", "categoryName");

-- CreateIndex
CREATE INDEX "order_category_facts_regionCode_date_status_orderTotal_idx" ON "order_category_facts"("regionCode", "date", "status", "orderTotal");

-- CreateIndex
CREATE INDEX "order_category_facts_regionCode_status_date_orderTotal_cate_idx" ON "order_category_facts"("regionCode", "status", "date", "orderTotal", "categoryName");

-- CreateIndex
CREATE INDEX "order_events_orderId_idx" ON "order_events"("orderId");

-- CreateIndex
CREATE INDEX "daily_summary_date_idx" ON "daily_summary"("date");

-- CreateIndex
CREATE INDEX "daily_summary_categoryId_idx" ON "daily_summary"("categoryId");

-- CreateIndex
CREATE INDEX "daily_summary_regionId_idx" ON "daily_summary"("regionId");

-- CreateIndex
CREATE INDEX "daily_summary_regionCode_date_idx" ON "daily_summary"("regionCode", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summary_date_categoryId_regionId_key" ON "daily_summary"("date", "categoryId", "regionId");

-- CreateIndex
CREATE INDEX "daily_filter_category_summary_date_status_idx" ON "daily_filter_category_summary"("date", "status");

-- CreateIndex
CREATE INDEX "daily_filter_category_summary_status_date_categoryName_idx" ON "daily_filter_category_summary"("status", "date", "categoryName");

-- CreateIndex
CREATE INDEX "daily_filter_category_summary_date_status_regionId_idx" ON "daily_filter_category_summary"("date", "status", "regionId");

-- CreateIndex
CREATE INDEX "daily_filter_category_summary_regionCode_status_date_catego_idx" ON "daily_filter_category_summary"("regionCode", "status", "date", "categoryName");

-- CreateIndex
CREATE INDEX "daily_filter_category_summary_regionCode_date_status_idx" ON "daily_filter_category_summary"("regionCode", "date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "daily_filter_category_summary_date_regionId_status_category_key" ON "daily_filter_category_summary"("date", "regionId", "status", "categoryId");

-- CreateIndex
CREATE INDEX "daily_status_category_summary_status_date_categoryName_idx" ON "daily_status_category_summary"("status", "date", "categoryName");

-- CreateIndex
CREATE UNIQUE INDEX "daily_status_category_summary_date_status_categoryId_key" ON "daily_status_category_summary"("date", "status", "categoryId");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_customerId_date_idx" ON "daily_customer_category_summary"("customerId", "date");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_date_status_idx" ON "daily_customer_category_summary"("date", "status");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_status_date_customerId_cate_idx" ON "daily_customer_category_summary"("status", "date", "customerId", "categoryName");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_date_regionId_idx" ON "daily_customer_category_summary"("date", "regionId");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_date_status_regionId_idx" ON "daily_customer_category_summary"("date", "status", "regionId");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_regionCode_date_idx" ON "daily_customer_category_summary"("regionCode", "date");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_regionCode_date_customerId__idx" ON "daily_customer_category_summary"("regionCode", "date", "customerId", "categoryName");

-- CreateIndex
CREATE INDEX "daily_customer_category_summary_regionCode_status_date_cust_idx" ON "daily_customer_category_summary"("regionCode", "status", "date", "customerId", "categoryName");

-- CreateIndex
CREATE UNIQUE INDEX "daily_customer_category_summary_date_customerId_regionId_st_key" ON "daily_customer_category_summary"("date", "customerId", "regionId", "status", "categoryId");

-- CreateIndex
CREATE INDEX "daily_customer_token_category_summary_token_date_idx" ON "daily_customer_token_category_summary"("token", "date");

-- CreateIndex
CREATE INDEX "daily_customer_token_category_summary_token_date_status_idx" ON "daily_customer_token_category_summary"("token", "date", "status");

-- CreateIndex
CREATE INDEX "daily_customer_token_category_summary_token_date_regionId_idx" ON "daily_customer_token_category_summary"("token", "date", "regionId");

-- CreateIndex
CREATE INDEX "daily_customer_token_category_summary_token_date_status_reg_idx" ON "daily_customer_token_category_summary"("token", "date", "status", "regionId");

-- CreateIndex
CREATE INDEX "daily_customer_token_category_summary_token_regionCode_date_idx" ON "daily_customer_token_category_summary"("token", "regionCode", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_customer_token_category_summary_date_token_regionId_s_key" ON "daily_customer_token_category_summary"("date", "token", "regionId", "status", "categoryId");

-- CreateIndex
CREATE INDEX "daily_customer_token_category_rollup_token_date_idx" ON "daily_customer_token_category_rollup"("token", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_customer_token_category_rollup_date_token_categoryId_key" ON "daily_customer_token_category_rollup"("date", "token", "categoryId");

-- CreateIndex
CREATE INDEX "daily_customer_token_order_summary_token_date_idx" ON "daily_customer_token_order_summary"("token", "date");

-- CreateIndex
CREATE INDEX "daily_customer_token_order_summary_token_date_status_idx" ON "daily_customer_token_order_summary"("token", "date", "status");

-- CreateIndex
CREATE INDEX "daily_customer_token_order_summary_token_date_regionId_idx" ON "daily_customer_token_order_summary"("token", "date", "regionId");

-- CreateIndex
CREATE INDEX "daily_customer_token_order_summary_token_date_status_region_idx" ON "daily_customer_token_order_summary"("token", "date", "status", "regionId");

-- CreateIndex
CREATE INDEX "daily_customer_token_order_summary_token_regionCode_date_idx" ON "daily_customer_token_order_summary"("token", "regionCode", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_customer_token_order_summary_date_token_regionId_stat_key" ON "daily_customer_token_order_summary"("date", "token", "regionId", "status");

-- CreateIndex
CREATE INDEX "search_index_entityType_idx" ON "search_index"("entityType");

-- CreateIndex
CREATE UNIQUE INDEX "search_index_entityType_entityId_key" ON "search_index"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_idx" ON "audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_idx" ON "audit_log"("actorId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

