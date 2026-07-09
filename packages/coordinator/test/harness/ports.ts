import type { BusEvent } from "@openomni/protocol";
import type { WorkerPorts } from "../../src/worker-manager";

export type CollectedEvent = { event: BusEvent.Descriptor<unknown>; data: unknown };

/**
 * Test binding for the driver's ports (#462 §2): events go to an in-memory
 * collector instead of the ledger Bus.
 */
export function collectorPorts(): WorkerPorts & { collected: CollectedEvent[] } {
  const collected: CollectedEvent[] = [];
  return {
    collected,
    events: {
      publish(event, data) {
        collected.push({ event: event as BusEvent.Descriptor<unknown>, data });
      },
    },
  };
}
