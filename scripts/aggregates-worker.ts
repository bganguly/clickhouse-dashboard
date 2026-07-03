/**
 * Aggregates worker: drains the order_events outbox, applying the 7
 * per-order aggregate-table writes (order_category_facts + 6
 * daily_*_summary/rollup upserts) that createOrder used to fire off
 * unawaited. LISTEN orders_channel is a low-latency wake-up nudge only —
 * the source of truth for pending work is always the order_events table
 * itself, polled on an interval, since NOTIFY payloads are dropped for
 * listeners that aren't currently connected (e.g. right after a restart).
 *
 * Run via scripts/start-aggregates-worker.sh (nohup + pidfile), not directly.
 */
import { Client } from "pg";
import { prisma } from "@/lib/prisma";
import { resolvePgUrl } from "@/lib/pg-url";
import {
  updateDailyCustomerCategorySummary,
  updateDailyCustomerTokenCategoryRollup,
  updateDailyCustomerTokenCategorySummary,
  updateDailyFilterCategorySummary,
  updateDailySummary,
  updateDailyStatusCategorySummary,
  updateOrderCategoryFacts,
} from "@/lib/services/aggregates.service";

const CHANNEL = "orders_channel";
const MAX_ATTEMPTS = 5;
const IDLE_POLL_INTERVAL_MS = 2000;

const AGGREGATE_UPDATERS = [
  updateOrderCategoryFacts,
  updateDailySummary,
  updateDailyCustomerCategorySummary,
  updateDailyFilterCategorySummary,
  updateDailyStatusCategorySummary,
  updateDailyCustomerTokenCategorySummary,
  updateDailyCustomerTokenCategoryRollup,
] as const;

let draining = false;

async function claimAndProcessOne(): Promise<"processed" | "empty" | "failed"> {
  let claimed: { id: number; orderId: number } | undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: number; orderId: number }[]>`
        SELECT id, "orderId" FROM order_events
        WHERE "processedAt" IS NULL AND attempts < ${MAX_ATTEMPTS}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      const event = rows[0];
      if (!event) return "empty" as const;
      claimed = event;

      for (const update of AGGREGATE_UPDATERS) {
        await update(event.orderId, tx);
      }
      await tx.orderEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
      return "processed" as const;
    });
  } catch (err) {
    // The transaction above rolled back automatically on throw — no partial
    // aggregate writes were persisted. Record the failure in a SEPARATE
    // statement so the bookkeeping itself isn't rolled back with the failed work.
    if (claimed) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      await prisma.orderEvent
        .update({ where: { id: claimed.id }, data: { attempts: { increment: 1 }, lastError: message } })
        .catch((e) => console.error("aggregates-worker: failed to record error:", e));
    } else {
      console.error("aggregates-worker: error claiming next event:", err);
    }
    return "failed";
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      if ((await claimAndProcessOne()) === "empty") break;
    }
  } finally {
    draining = false;
  }
}

async function main() {
  const pg = new Client({ connectionString: resolvePgUrl() });
  await pg.connect();
  await pg.query(`LISTEN ${CHANNEL}`);
  pg.on("notification", () => void drain());
  pg.on("error", (err) => console.error("aggregates-worker: LISTEN connection error:", err));

  console.log(`aggregates-worker started — LISTEN ${CHANNEL}, polling every ${IDLE_POLL_INTERVAL_MS}ms`);
  await drain(); // catch up on backlog from before this process started

  const interval = setInterval(() => void drain(), IDLE_POLL_INTERVAL_MS);

  const stop = async () => {
    clearInterval(interval);
    await Promise.all([prisma.$disconnect(), pg.end()]);
    console.log("aggregates-worker stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
