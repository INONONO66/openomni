export { testBus, testBusService, type TestObservationBus } from "./isolated";
import { testBus } from "./isolated";

let traceCounter = 0;

/** Deterministic 32-hex trace ids for fixtures; production mints via traceIdFromUuid over injected entropy. */
export function newTraceId(): string {
  traceCounter += 1;
  return traceCounter.toString(16).padStart(32, "0");
}

/** The package-shared bus fixture; suites reset() it between cases. */
export const Bus = testBus();
