import type { BusEvent } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

export async function withinTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("expected Bus delivery signal")), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Subscribe before publishing; resolves after the final queued delivery for this event. */
export function signalAfterDeliveries<T extends Bus.Data>(
  event: BusEvent.Descriptor<T>,
  expectedCount: number,
): Promise<void> {
  const completed = Promise.withResolvers<void>();
  let delivered = 0;
  const unsubscribe = Bus.subscribe(event, () => {
    delivered += 1;
    if (delivered === expectedCount) {
      unsubscribe();
      completed.resolve();
    }
  });
  return withinTimeout(completed.promise);
}
