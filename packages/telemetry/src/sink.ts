import type { BusEvent } from "@openomni/protocol";

interface CollectedEvent {
  readonly name: string;
  readonly data: unknown;
}

export interface CollectingSink extends BusEvent.Sink {
  readonly events: readonly CollectedEvent[];
  named(name: string): readonly unknown[];
  reset(): void;
}

/** Records instead of publishing. For tests and for the workflow harness. */
export function collector(): CollectingSink {
  const events: CollectedEvent[] = [];
  return {
    publish(event, data) {
      events.push({ name: event.name, data });
    },
    events,
    named: (name) => events.filter((event) => event.name === name).map((event) => event.data),
    reset: () => {
      events.length = 0;
    },
  };
}

export interface TeeOptions {
  /**
   * Called when a downstream sink throws. Defaults to a console warning.
   *
   * A throwing sink must never reach the caller: observation does not get to
   * change what the observed code does. That is this package's boundary test —
   * replacing it entirely with no-ops has to leave behavior identical.
   */
  readonly onSinkError?: (error: unknown, eventName: string) => void;
}

/** Fans one publish out to several sinks. One failing does not stop the rest. */
export function tee(sinks: readonly BusEvent.Sink[], options: TeeOptions = {}): BusEvent.Sink {
  const onSinkError =
    options.onSinkError ??
    ((error, eventName) =>
      console.warn("telemetry sink error", { eventName, error: String(error) }));

  return {
    publish(event, data) {
      for (const sink of sinks) {
        try {
          sink.publish(event, data);
        } catch (error) {
          // The reporter is caller-supplied too, and a throw here would stop
          // the fan-out this function exists to guarantee.
          try {
            onSinkError(error, event.name);
          } catch {
            // Nothing left to report to.
          }
        }
      }
    },
  };
}

/** Discards everything. The reference point for the boundary test above. */
export function noopSink(): BusEvent.Sink {
  return { publish: () => undefined };
}
