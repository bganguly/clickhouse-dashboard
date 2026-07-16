import { query, insert } from "@/lib/clickhouse";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateCustomerInput, CustomerDTO, CustomerListInput, CustomerListResult,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toDTO(r: {
  customerId: string; email: string; firstName: string; lastName: string;
  phone: string | null; regionId: string; regionCode: string; regionName: string;
  createdAt: string;
}): CustomerDTO {
  return {
    id: Number(r.customerId),
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    phone: r.phone,
    region: { id: Number(r.regionId), code: r.regionCode, name: r.regionName },
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function listCustomers(input: CustomerListInput): Promise<CustomerListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const q = input.q?.trim();

  const clauses: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };

  if (q) {
    clauses.push(`positionCaseInsensitive(firstName || ' ' || lastName || ' ' || email, {q: String}) > 0`);
    params["q"] = q;
  }
  if (input.regionId) {
    clauses.push(`c.regionId = {regionId: UInt32}`);
    params["regionId"] = input.regionId;
  }
  if (input.cursor) {
    clauses.push(`c.customerId > {cursor: UInt64}`);
    params["cursor"] = input.cursor;
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const rows = await query<{
      customerId: string; email: string; firstName: string; lastName: string;
      phone: string | null; regionId: string; regionCode: string; regionName: string;
      createdAt: string;
    }>(
      `SELECT c.customerId, c.email, c.firstName, c.lastName, c.phone, c.regionId,
              r.code AS regionCode, r.name AS regionName, c.createdAt
       FROM customers c JOIN regions r ON r.regionId = c.regionId
       ${where}
       ORDER BY c.customerId ASC
       LIMIT {lim: UInt32}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listCustomers");
  }
}

export async function getCustomer(id: number): Promise<CustomerDTO> {
  try {
    const rows = await query<{
      customerId: string; email: string; firstName: string; lastName: string;
      phone: string | null; regionId: string; regionCode: string; regionName: string;
      createdAt: string;
    }>(
      `SELECT c.customerId, c.email, c.firstName, c.lastName, c.phone, c.regionId,
              r.code AS regionCode, r.name AS regionName, c.createdAt
       FROM customers c JOIN regions r ON r.regionId = c.regionId
       WHERE c.customerId = {id: UInt64} LIMIT 1`,
      { id },
    );
    if (rows.length === 0) throw new AppError("NOT_FOUND", `customer ${id} not found`);
    return toDTO(rows[0]);
  } catch (err) {
    mapDbError(err, "getCustomer");
  }
}

let _customerId = Date.now();

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerDTO> {
  if (!input.email || !input.firstName || !input.lastName || !input.regionId) {
    throw new AppError("BAD_REQUEST", "email, firstName, lastName, and regionId are required");
  }
  try {
    const regionRows = await query<{ regionId: string; code: string; name: string }>(
      `SELECT regionId, code, name FROM regions WHERE regionId = {rid: UInt32} LIMIT 1`,
      { rid: input.regionId },
    );
    if (regionRows.length === 0) throw new AppError("NOT_FOUND", `region ${input.regionId} not found`);

    const customerId = ++_customerId;
    await insert("customers", [{
      customerId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? null,
      regionId: input.regionId,
      createdAt: new Date().toISOString().replace("T", " ").replace("Z", ""),
    }]);

    return {
      id: customerId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? null,
      region: { id: input.regionId, code: regionRows[0].code, name: regionRows[0].name },
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    mapDbError(err, "createCustomer");
  }
}
