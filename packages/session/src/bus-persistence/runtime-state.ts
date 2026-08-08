import { Bus, BusEvent } from "../bus/index.js";
import { writeOperationalToStdout } from "./operational-logging.js";
import { parsePayload } from "./payload.js";
import { flushPersistQueue, persist } from "./persistence-writer.js";
import { defaultResolveSessionId } from "./session-id.js";
import type { BusPersistenceOptions, RuntimeState } from "./types.js";

let state: RuntimeState | undefined;

export function startBusPersistence(options: BusPersistenceOptions = {}): () => void {
  stopBusPersistence();

  const pending = new Set<Promise<void>>();
  const resolveSessionId = options.resolveSessionId ?? defaultResolveSessionId;
  const now = options.now ?? (() => new Date());

  const unsubscribe = Bus.observe((event, payload) => {
    const normalizedPayload = parsePayload(event, payload);

    writeOperationalToStdout(event.name, normalizedPayload);

    if ((event.visibility ?? "internal") === BusEvent.Visibility.Enum.ephemeral) {
      return;
    }

    const sessionId = resolveSessionId(event, normalizedPayload);
    // Publish order == enqueue order == row order: the writer's FIFO batch
    // queue (group commit, #510 D1) is the single ordering mechanism, so no
    // per-session promise chaining is needed — and chaining would defeat
    // group commit by forcing one batch per event.
    const write = persist({ event, payload: normalizedPayload, sessionId, now });
    pending.add(write);
    void write
      .catch((err) => {
        console.warn("BusPersistence: persist failed", {
          event: event.name,
          sessionId,
          error: String(err),
        });
      })
      .finally(() => {
        pending.delete(write);
      });
  });

  state = { unsubscribe, pending };
  return stopBusPersistence;
}

export function stopBusPersistence(): void {
  state?.unsubscribe();
  state = undefined;
}

export async function flushBusPersistence(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
  // Drain synchronously (shutdown path): commits every queued row now
  // instead of waiting for the scheduled microtask.
  flushPersistQueue();
  const pending = state ? [...state.pending] : [];
  await Promise.allSettled(pending);
}
