import { Bus, BusEvent } from "../bus/index.js";
import { writeOperationalToStdout } from "./operational-logging.js";
import { parsePayload } from "./payload.js";
import { persist } from "./persistence-writer.js";
import { defaultResolveSessionId } from "./session-id.js";
import type { BusPersistenceOptions, RuntimeState } from "./types.js";

const noSessionKey = "__openomni_bus_event_without_session__";

let state: RuntimeState | undefined;

export function startBusPersistence(options: BusPersistenceOptions = {}): () => void {
  stopBusPersistence();

  const chains = new Map<string, Promise<void>>();
  const resolveSessionId = options.resolveSessionId ?? defaultResolveSessionId;
  const now = options.now ?? (() => new Date());

  const unsubscribe = Bus.observe((event, payload) => {
    const normalizedPayload = parsePayload(event, payload);

    writeOperationalToStdout(event.name, normalizedPayload);

    if ((event.visibility ?? "internal") === BusEvent.Visibility.Enum.ephemeral) {
      return;
    }

    const sessionId = resolveSessionId(event, normalizedPayload);
    const key = sessionId ?? noSessionKey;
    const previous = chains.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => persist({ event, payload: normalizedPayload, sessionId, now }));

    chains.set(key, current);
    void current
      .catch((err) => {
        console.warn("BusPersistence: persist failed", {
          event: event.name,
          sessionId,
          error: String(err),
        });
      })
      .finally(() => {
        if (chains.get(key) === current) {
          chains.delete(key);
        }
      });
  });

  state = { unsubscribe, chains };
  return stopBusPersistence;
}

export function stopBusPersistence(): void {
  state?.unsubscribe();
  state = undefined;
}

export async function flushBusPersistence(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
  const pending = state ? [...state.chains.values()] : [];
  await Promise.allSettled(pending);
}
