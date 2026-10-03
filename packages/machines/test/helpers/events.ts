import { type BusEvent, Machine } from "@openomni/protocol";

type MachineEventPayload =
  | ReturnType<typeof Machine.Events.Attached.schema.parse>
  | ReturnType<typeof Machine.Events.Detached.schema.parse>;
export type RecordedEvent = {
  readonly name: string;
  readonly payload: MachineEventPayload;
};

/** Records host attach/detach events; `next` resolves on the NEXT named event. */
export function eventCollector() {
  const events: RecordedEvent[] = [];
  const waiters: Array<{ name: string; resolve: (event: RecordedEvent) => void }> = [];
  const sink: BusEvent.Sink = {
    publish(descriptor, payload) {
      const event =
        descriptor.name === Machine.Events.Attached.name
          ? { name: descriptor.name, payload: Machine.Events.Attached.schema.parse(payload) }
          : {
              name: descriptor.name,
              payload: Machine.Events.Detached.schema.parse(payload),
            };
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter && waiter.name === event.name) {
          waiters.splice(i, 1);
          waiter.resolve(event);
        }
      }
    },
  };
  return {
    sink,
    events,
    /** Resolves on the NEXT event of this name (bounded by bun's test timeout). */
    next(name: string): Promise<RecordedEvent> {
      return new Promise((resolve) => {
        waiters.push({ name, resolve });
      });
    },
  };
}
