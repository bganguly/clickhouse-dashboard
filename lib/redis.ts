import Redis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | null | undefined;
}

function makeClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false,
  });
  client.on("error", () => {});
  return client;
}

export const redis: Redis | null =
  process.env.NODE_ENV === "development"
    ? (globalThis.__redis ??= makeClient())
    : makeClient();
