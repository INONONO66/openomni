import { Session } from "@openomni/agent";
const createObservationBus = Session.createObservationBus;

/** A bus with deterministic scoped-event stamps (counter ids, counter times). */
function testBus(): ReturnType<typeof createObservationBus> {
  let id = 0;
  let time = 0;
  return createObservationBus({
    id: () => {
      id += 1;
      return `event-${id}`;
    },
    now: () => {
      time += 1;
      return time;
    },
  });
}

/** The shared fixture bus: tests that used the deleted agent-global Bus singleton use this one. */
export const Bus = testBus();

let traceCounter = 0;

/** Deterministic 32-hex trace ids for fixtures; production formats trace ids over injected entropy. */
export function newTraceId(): string {
  traceCounter += 1;
  return traceCounter.toString(16).padStart(32, "0");
}
