import { Client } from "pg";
import { AppError } from "@/lib/errors";
import { resolvePgUrl } from "@/lib/pg-url";
import type { OrderNotification } from "@/lib/types";
import { prisma } from "@/lib/prisma";

/**
 * Real-time order stream backed by Postgres LISTEN/NOTIFY. The raw `pg` driver
 * is an implementation detail that lives only inside this service; routes and
 * scripts interact through the typed functions below.
 */
const CHANNEL = "orders_channel";

// How many browser tabs currently have an open /api/stream SSE connection —
// i.e. how many have the "Live" checkbox on. Lets other apps (e.g. the
// quick-order companion) tell whether anything will actually reload live
// before a write, without reaching into another app's client-side state.
let activeConnections = 0;

export function getActiveStreamConnectionCount(): number {
  return activeConnections;
}

export interface OrderStreamHandlers {
  onConnect?: () => void;
  onOrder: (notification: OrderNotification) => void;
  onError?: (error: AppError) => void;
}

export interface StreamSubscription {
  close: () => Promise<void>;
}

export async function subscribeToOrders(
  handlers: OrderStreamHandlers,
): Promise<StreamSubscription> {
  let connectionString: string;
  let useSsl: boolean;
  try {
    const rawUrl = resolvePgUrl();
    const parsed = new URL(rawUrl);
    // Local Postgres (e.g. Homebrew) doesn't support SSL at all, so forcing it
    // unconditionally makes LISTEN/NOTIFY fail to connect against local dev DBs.
    // Only request SSL when the URL asked for it or the host isn't local.
    const sslmode = parsed.searchParams.get("sslmode");
    const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    useSsl = sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full" || !isLocalHost;
    // Strip sslmode from the URL so it doesn't conflict with the ssl constructor option.
    // pg v8 parses sslmode and can override the ssl object we pass in.
    parsed.searchParams.delete("sslmode");
    connectionString = parsed.toString();
  } catch (err) {
    throw new AppError("INTERNAL", err instanceof Error ? err.message : "invalid Postgres URL");
  }

  const client = new Client({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  let counted = false;
  const close = async () => {
    if (counted) {
      counted = false;
      activeConnections--;
    }
    try {
      await client.query("UNLISTEN *");
    } catch {
      // connection may already be broken (e.g. client hard-reloaded) — fine,
      // the socket-destroy fallback below guarantees teardown regardless.
    }
    try {
      // client.end() can silently fail to fully tear down an already-broken
      // socket (a hard browser reload sends an abrupt TCP RST mid-connection),
      // leaking the Postgres backend indefinitely with no error surfaced —
      // race it against a timeout and force-destroy the raw socket if it
      // doesn't resolve, so no connection can outlive this close() call.
      await Promise.race([
        client.end(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // fall through to the forced destroy below
    } finally {
      try {
        const raw = client as unknown as { connection?: { stream?: { destroyed?: boolean; destroy?: () => void } } };
        if (raw.connection?.stream && !raw.connection.stream.destroyed) {
          raw.connection.stream.destroy?.();
        }
      } catch {
        // already gone
      }
    }
  };

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
  } catch (err) {
    await close();
    throw new AppError("DB_ERROR", "failed to subscribe to the order stream", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  counted = true;
  activeConnections++;

  client.on("notification", (msg) => {
    try {
      const payload = msg.payload ? (JSON.parse(msg.payload) as OrderNotification) : null;
      if (payload) handlers.onOrder(payload);
    } catch {
      handlers.onError?.(new AppError("INTERNAL", "failed to parse order notification"));
    }
  });

  client.on("error", (err) => {
    handlers.onError?.(
      new AppError("DB_ERROR", "order stream connection error", { cause: err.message }),
    );
  });

  handlers.onConnect?.();
  return { close };
}

/**
 * Publish an order event to every connected SSE subscriber. Uses the Prisma
 * connection pool so no new TCP connection is opened per call.
 */
export async function publishOrderEvent(notification: OrderNotification): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify('orders_channel', ${JSON.stringify(notification)})`;
}
