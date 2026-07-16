import { query, insert } from "@/lib/clickhouse";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateProductInput, ProductDTO, ProductListInput, ProductListResult,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toDTO(r: {
  productId: string; sku: string; name: string; description: string | null;
  price: string; cost: string; stock: string; categoryId: string; categoryName: string;
}): ProductDTO {
  return {
    id: Number(r.productId),
    sku: r.sku,
    name: r.name,
    description: r.description,
    price: Number(r.price),
    cost: Number(r.cost),
    stock: Number(r.stock),
    categoryId: Number(r.categoryId),
    categoryName: r.categoryName,
  };
}

export async function listProducts(input: ProductListInput): Promise<ProductListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const clauses: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };

  if (input.q?.trim()) {
    clauses.push(`positionCaseInsensitive(p.name || ' ' || p.sku, {q: String}) > 0`);
    params["q"] = input.q.trim();
  }
  if (input.categoryId) {
    clauses.push(`p.categoryId = {categoryId: UInt32}`);
    params["categoryId"] = input.categoryId;
  }
  if (input.cursor) {
    clauses.push(`p.productId > {cursor: UInt32}`);
    params["cursor"] = input.cursor;
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const rows = await query<{
      productId: string; sku: string; name: string; description: string | null;
      price: string; cost: string; stock: string; categoryId: string; categoryName: string;
    }>(
      `SELECT p.productId, p.sku, p.name, p.description, p.price, p.cost, p.stock,
              p.categoryId, c.name AS categoryName
       FROM products p JOIN categories c ON c.categoryId = p.categoryId
       ${where}
       ORDER BY p.productId ASC
       LIMIT {lim: UInt32}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listProducts");
  }
}

export async function getProduct(id: number): Promise<ProductDTO> {
  try {
    const rows = await query<{
      productId: string; sku: string; name: string; description: string | null;
      price: string; cost: string; stock: string; categoryId: string; categoryName: string;
    }>(
      `SELECT p.productId, p.sku, p.name, p.description, p.price, p.cost, p.stock,
              p.categoryId, c.name AS categoryName
       FROM products p JOIN categories c ON c.categoryId = p.categoryId
       WHERE p.productId = {id: UInt32} LIMIT 1`,
      { id },
    );
    if (rows.length === 0) throw new AppError("NOT_FOUND", `product ${id} not found`);
    return toDTO(rows[0]);
  } catch (err) {
    mapDbError(err, "getProduct");
  }
}

let _productId = Date.now();

export async function createProduct(input: CreateProductInput): Promise<ProductDTO> {
  if (!input.sku || !input.name || input.price == null || input.cost == null || !input.categoryId) {
    throw new AppError("BAD_REQUEST", "sku, name, price, cost, and categoryId are required");
  }
  try {
    const catRows = await query<{ categoryId: string; name: string }>(
      `SELECT categoryId, name FROM categories WHERE categoryId = {cid: UInt32} LIMIT 1`,
      { cid: input.categoryId },
    );
    if (catRows.length === 0) throw new AppError("NOT_FOUND", `category ${input.categoryId} not found`);

    const productId = ++_productId;
    await insert("products", [{
      productId,
      sku: input.sku,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      cost: input.cost,
      stock: input.stock ?? 0,
      categoryId: input.categoryId,
      createdAt: new Date().toISOString().replace("T", " ").replace("Z", ""),
    }]);

    return {
      id: productId,
      sku: input.sku,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      cost: input.cost,
      stock: input.stock ?? 0,
      categoryId: input.categoryId,
      categoryName: catRows[0].name,
    };
  } catch (err) {
    mapDbError(err, "createProduct");
  }
}
