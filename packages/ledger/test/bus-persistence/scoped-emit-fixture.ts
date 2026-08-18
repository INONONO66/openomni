/**
 * Local binding of a scoped emitter onto the Bus.
 *
 * `@openomni/telemetry` deliberately ships no `busSink()` — an abstraction is
 * earned by its second consumer, and the first production one lands with the
 * driver conversion (#606 Phase 1b). This fixture is that binding for the one
 * attribution test that needs it.
 */
import { Bus } from "@openomni/telemetry";
import type { BusEvent } from "@openomni/protocol";

export { Bus, newTraceId, scope } from "@openomni/telemetry";

export function busSinkForTest(): BusEvent.Sink {
  return { publish: Bus.publish };
}
