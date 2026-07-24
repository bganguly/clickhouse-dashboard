import { Client } from "typesense";

const COLLECTION = "orders";

let _client: Client | null | undefined;

function getClient(): Client | null {
  if (_client !== undefined) return _client;
  const url = process.env.TYPESENSE_URL;
  const apiKey = process.env.TYPESENSE_API_KEY;
  if (!url || !apiKey) { _client = null; return null; }
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 8108);
    _client = new Client({
      nodes: [{ host: parsed.hostname, port, protocol: parsed.protocol.replace(":", "") as "http" | "https" }],
      apiKey,
      connectionTimeoutSeconds: 2,
      retryIntervalSeconds: 0.1,
      numRetries: 1,
    });
  } catch {
    _client = null;
  }
  return _client;
}

export function isEnabled(): boolean {
  return !!(process.env.TYPESENSE_URL && process.env.TYPESENSE_API_KEY);
}

export async function ensureCollection(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.collections(COLLECTION).retrieve();
  } catch {
    await client.collections().create({
      name: COLLECTION,
      fields: [
        { name: "id", type: "string" as const },
        { name: "searchText", type: "string" as const },
      ],
    });
  }
}

export async function indexOrder(orderId: number, searchText: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.collections(COLLECTION).documents().upsert({ id: String(orderId), searchText });
}

export async function searchOrderIds(q: string): Promise<number[]> {
  const client = getClient();
  if (!client) return [];
  try {
    const result = await client.collections(COLLECTION).documents().search({
      q,
      query_by: "searchText",
      per_page: 250,
      prefix: true,
    });
    return (result.hits ?? []).map((h: { document: unknown }) => Number((h.document as { id: string }).id));
  } catch {
    return [];
  }
}
