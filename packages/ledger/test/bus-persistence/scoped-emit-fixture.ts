/**
 * Local binding of a scoped emitter onto the Bus.
 *
 * The fixture keeps Bus isolation explicit while production uses
 * `scope(..., Bus).sink`.
 */
import { Bus } from "@openomni/telemetry";
import type { BusEvent } from "@openomni/protocol";

export { Bus, newTraceId, scope } from "@openomni/telemetry";

export function busSinkForTest(): BusEvent.Sink {
  return { publish: Bus.publish };
}
