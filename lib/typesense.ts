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

const _prefixCache = new Map<string, { token: string; ts: number }>();
const _PREFIX_TTL_MS = 10 * 60 * 1000;

export async function expandPrefix(prefix: string): Promise<string> {
  const hit = _prefixCache.get(prefix);
  if (hit && Date.now() - hit.ts < _PREFIX_TTL_MS) return hit.token;

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
    const best = result.hits?.[0];
    const token = best ? (best.document as { token: string }).token : prefix;
    _prefixCache.set(prefix, { token, ts: Date.now() });
    return token;
  } catch {
    return prefix;
  }
}
