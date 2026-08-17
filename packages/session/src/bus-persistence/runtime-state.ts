import { Operational } from "@openomni/protocol";
import { Bus, BusEvent } from "@openomni/telemetry";
import { toRecord } from "./record-fields.js";
import { writeOperationalToStdout } from "./operational-logging.js";
import { parsePayload } from "./payload.js";
import { flushPersistQueue, persist } from "./persistence-writer.js";
import { defaultResolveSessionId } from "./session-id.js";
import type { BusPersistenceOptions, RuntimeState } from "./types.js";

let state: RuntimeState | undefined;

const SELF_COMPONENT = "bus-persistence";

/**
 * Telemetry is lossy-tolerant by contract, but a drop must be LOUD, never a
 * console-only whisper: every dropped row increments this counter (surfaced
 * via BusPersistence.stats) and publishes one Operational.Warn — which is
 * itself a persisted bus event, so the audit trail records its own gap.
 */
let droppedEventCount = 0;

export function busPersistenceStats(): { readonly droppedEventCount: number } {
  return { droppedEventCount };
}

/**
 * Recursion guard: a persist failure of our OWN drop-warning must not publish
 * another drop-warning (a persistent write failure would loop forever).
 */
function isSelfWarn(event: Bus.PublishedDescriptor, payload: unknown): boolean {
  if (event.name !== Operational.Warn.name) return false;
  return toRecord(payload)?.component === SELF_COMPONENT;
}

function reportDroppedEvent(
  event: Bus.PublishedDescriptor,
  payload: unknown,
  sessionId: string | undefined,
  err: unknown,
): void {
  droppedEventCount += 1;
  if (isSelfWarn(event, payload)) {
    // Last-resort channel only — re-publishing would recurse.
    console.warn("BusPersistence: dropped own drop-warning", { error: String(err) });
    return;
  }
  const traceId = toRecord(payload)?.traceId;
  Bus.publish(Operational.Warn, {
    traceId: typeof traceId === "string" ? traceId : "untraced",
    time: Date.now(),
    ...(sessionId === undefined ? {} : { sessionId }),
    component: SELF_COMPONENT,
    msg: `bus event dropped from persistence: ${event.name}`,
    context: {
      event: event.name,
      droppedEventCount,
      error: String(err),
    },
  });
}

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
        reportDroppedEvent(event, normalizedPayload, sessionId, err);
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
