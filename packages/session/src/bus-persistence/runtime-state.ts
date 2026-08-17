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
  // The dropped event's sessionId rides in `context`, never at the payload
  // root: the dominant drop class IS an FK-dead sessionId, and a root-level
  // stamp would make the resolver attribute this warn to the same dead
  // session — FK-failing the warn's own insert and degrading the "audit
  // trail records its own gap" guarantee to a console whisper. Sessionless,
  // the warn always persists.
  Bus.publish(Operational.Warn, {
    traceId: typeof traceId === "string" ? traceId : "untraced",
    time: Date.now(),
    component: SELF_COMPONENT,
    msg: `bus event dropped from persistence: ${event.name}`,
    context: {
      event: event.name,
      ...(sessionId === undefined ? {} : { droppedSessionId: sessionId }),
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

/**
 * Bound on quiescence turns, not a target: each turn advances one microtask
 * hop of subscriber cascade (publish → observer → enqueue), so the bound
 * supports cascades several levels deeper than anything in the tree while
 * guaranteeing a pathological self-publishing subscriber cannot wedge the
 * exit path this barrier protects.
 */
const MAX_FLUSH_TURNS = 16;

export async function flushBusPersistence(): Promise<void> {
  // Pre-exit barrier: when this resolves, every row implied by publishes
  // that happened before the call — including rows published by subscribers
  // reacting to those publishes — is committed. One turn per iteration lets
  // already-queued subscriber microtasks enqueue; the drain commits; a turn
  // that commits nothing with no writes in flight proves quiescence.
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    await new Promise((resolve) => queueMicrotask(resolve));
    const committed = flushPersistQueue();
    const pending = state ? [...state.pending] : [];
    if (committed === 0 && pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}
