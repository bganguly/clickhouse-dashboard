import { EventEmitter } from "events";
import { AppError } from "@/lib/errors";
import type { OrderNotification } from "@/lib/types";

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

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
  activeConnections++;
  const onOrder = (n: OrderNotification) => handlers.onOrder(n);
  emitter.on("order", onOrder);
  handlers.onConnect?.();

  return {
    close: async () => {
      activeConnections--;
      emitter.off("order", onOrder);
    },
  };
}

export function publishOrderEvent(notification: OrderNotification): Promise<void> {
  emitter.emit("order", notification);
  return Promise.resolve();
}
