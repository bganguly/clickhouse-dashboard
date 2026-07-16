import { NextRequest } from "next/server";
import { subscribeToOrders } from "@/lib/services";
import type { StreamEventName } from "@/lib/types";

// GET /api/stream — SSE endpoint. Delegates to the stream service (in-process
// EventEmitter); this handler only adapts the subscription to the SSE wire format.
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEventName, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let subscription: { close: () => Promise<void> } | undefined;
      let closed = false;

      const shutdown = async () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (subscription) await subscription.close();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      try {
        subscription = await subscribeToOrders({
          onConnect: () => send("connected", { ts: new Date().toISOString() }),
          onOrder: (n) => send("order", n),
          onError: (e) => {
            send("error", { message: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) });
            void shutdown();
          },
        });

        heartbeat = setInterval(() => send("heartbeat", { ts: new Date().toISOString() }), 25_000);

        req.signal.addEventListener("abort", () => {
          void shutdown();
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "stream failed";
        const details = err instanceof Error && "details" in err ? (err as { details: unknown }).details : undefined;
        send("error", { message, ...(details ? { details } : {}) });
        await shutdown();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
