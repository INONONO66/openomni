import type { BusEvent } from "@openomni/protocol";
import { Bus } from "../../src/index";

const EVENT_TIMEOUT_MS = 1_000;

/** Resolve after the expected events arrive; stay subscribed so callers can assert exact counts. */
export function captureBusEvents<T>(
  event: BusEvent.Descriptor<T>,
  count = 1,
  onEvent?: (event: T) => void,
): { readonly events: T[]; readonly done: Promise<readonly T[]>; unsubscribe: () => void } {
  const events: T[] = [];
  let unsubscribe: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<readonly T[]>((resolve, reject) => {
    timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for ${count} ${event.name} event(s); received ${events.length}`,
        ),
      );
    }, EVENT_TIMEOUT_MS);
    unsubscribe = Bus.subscribe(event, (payload) => {
      events.push(payload);
      onEvent?.(payload);
      if (events.length !== count) return;
      if (timer !== undefined) clearTimeout(timer);
      resolve(events);
    });
  });

  return {
    events,
    done,
    unsubscribe: () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    },
  };
}
