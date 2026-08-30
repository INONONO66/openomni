import { Component } from "@openomni/protocol";
import { Bus, scope, type TraceScope } from "@openomni/telemetry";
import type { BusEvent } from "@openomni/protocol";

export interface ObservedComponent {
  readonly events: BusEvent.Sink;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Binds one invocation-scoped component generation to the process Bus.
 *
 * This owns observation only: it neither authorizes the operation nor changes
 * its result. Registration rollback and durable facts remain with their
 * respective composition and ledger owners.
 */
export function observeComponent(
  trace: Omit<TraceScope, "spanId"> & { readonly spanId?: string },
): ObservedComponent {
  const observation = scope(trace, Bus);

  return {
    events: observation.sink,
    async run(operation) {
      observation.emit(Component.Events.Active, {});
      try {
        const result = await operation();
        observation.emit(Component.Events.Disposed, { outcome: "completed" });
        return result;
      } catch (error) {
        observation.emit(Component.Events.Failed, {
          error: error instanceof Error ? error.message : String(error),
        });
        observation.emit(Component.Events.Disposed, { outcome: "failed" });
        throw error;
      }
    },
  };
}
