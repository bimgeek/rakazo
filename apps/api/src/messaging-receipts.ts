import { randomUUID } from "node:crypto";
import type { MessagingReceipt, MessagingSurface } from "@rakazo/adapter-kit";
import { providerOfThreadId } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";

/**
 * Typing bubbles are a live progress signal, so they go out at once. A
 * reaction is a permanent mark, so it only goes on a message whose reply is
 * late: a fast reply is its own acknowledgement.
 */
export const RECEIPT_DELAY_MS: Record<MessagingReceipt, number> = {
  typing: 0,
  reaction: 60_000,
};

const RECEIPT_TIMEOUT_MS = 2000;

export interface MessagingReceipts {
  /** `answered` reads the caller's durable delivery record when a delayed receipt fires. */
  acknowledge(threadId: string, handle: string, answered: () => Promise<boolean>): void;
  stop(): void;
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
  delays: Record<MessagingReceipt, number> = RECEIPT_DELAY_MS,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const send = async (threadId: string, handle: string): Promise<void> => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    await messaging.acknowledge(threadId, handle, {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
  };
  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  return {
    acknowledge(threadId, handle, answered) {
      const provider = providerOfThreadId(threadId);
      const receipt = messaging.platforms().find((platform) => platform.provider === provider)
        ?.capabilities.receipt;
      if (!receipt) return;
      const delay = delays[receipt];
      if (delay <= 0) {
        send(threadId, handle).catch(logFailure);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        (async () => {
          if (await answered()) return;
          await send(threadId, handle);
        })().catch(logFailure);
      }, delay);
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
