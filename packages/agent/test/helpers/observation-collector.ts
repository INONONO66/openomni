import type { ObservationSink } from "@openomni/protocol";

export interface CollectingObservationSink extends ObservationSink {
  readonly events: readonly { readonly name: string; readonly data: unknown }[];
  named(name: string): readonly unknown[];
  reset(): void;
}

/** Records every published observation so a test can assert on scoped payloads. */
export function collector(): CollectingObservationSink {
  const events: { readonly name: string; readonly data: unknown }[] = [];
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
