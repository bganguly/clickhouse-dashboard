import { Client } from "typesense";

const COLLECTION = "vocabulary";

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
        { name: "id",        type: "string" as const },
        { name: "token",     type: "string" as const },
        { name: "doc_freq",  type: "int32"  as const },
      ],
    });
  }
}

export async function indexTokens(
  tokens: Array<{ token: string; docFreq?: number }>,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  const docs = tokens.map((t) => ({ id: t.token, token: t.token, doc_freq: t.docFreq ?? 1 }));
  await client.collections(COLLECTION).documents().import(docs, { action: "upsert" });
}

/**
 * Expand a potentially-partial prefix to the best matching full token in the vocabulary.
 * Returns the original prefix unchanged if Typesense is unavailable or no match is found.
 * Uses sort_by doc_freq:desc so the most common full-word wins (e.g. "conferenc" → "conference").
 */
export async function expandPrefix(prefix: string): Promise<string> {
  const client = getClient();
  if (!client) return prefix;
  try {
    const result = await client.collections(COLLECTION).documents().search({
      q: prefix,
      query_by: "token",
      per_page: 1,
      prefix: true,
      sort_by: "doc_freq:desc",
    });
    const hit = result.hits?.[0];
    if (!hit) return prefix;
    return (hit.document as { token: string }).token;
  } catch {
    return prefix;
  }
}
