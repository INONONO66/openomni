import { createObservationBus, type ObservationBus } from "../../src/observation/bus";

let traceCounter = 0;

/** Deterministic 32-hex trace ids for fixtures; production mints via traceIdFromUuid over injected entropy. */
export function newTraceId(): string {
  traceCounter += 1;
  return traceCounter.toString(16).padStart(32, "0");
}

/** A bus with deterministic scoped-event stamps (counter ids, counter times). */
export function testBus(onError?: (error: Error, eventName: string) => void): ObservationBus {
  let id = 0;
  let time = 0;
  return createObservationBus({
    id: () => `event-${(id += 1)}`,
    now: () => (time += 1),
    ...(onError === undefined ? {} : { onError }),
  });
}

/** The shared fixture bus: tests that used the package-global Bus singleton use this one. */
export const Bus = testBus();
