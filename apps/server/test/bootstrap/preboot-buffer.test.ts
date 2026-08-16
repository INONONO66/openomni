import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Operational } from "@openomni/protocol";
import { BusPersistence, Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";

function journalRows(): Array<{ event_type: string; trace_id: string }> {
  const descriptor = Object.getOwnPropertyDescriptor(Storage.getAdapter(), "db");
  if (!(descriptor?.value instanceof Database)) throw new Error("expected sqlite adapter");
  return descriptor.value.query("SELECT event_type, trace_id FROM bus_event").all() as Array<{
    event_type: string;
    trace_id: string;
  }>;
}

describe("pre-persistence boot window (#606 / #676 review)", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
  });

  afterEach(() => {
    BusPersistence.stop();
    Storage.reset();
    Bus.reset();
  });

  test("a warn published before BusPersistence.start survives into the journal", async () => {
    // The exact bootstrap sequence: buffer -> config-time publish -> storage
    // init -> persistence start -> ONE microtask turn (observer delivery is
    // microtask-queued; without it the buffer is provably empty) -> republish.
    const preBootEvents: Array<Parameters<typeof Bus.publish>> = [];
    const stopBuffering = Bus.observe((descriptor, data) => {
      preBootEvents.push([descriptor, data] as Parameters<typeof Bus.publish>);
    });

    Bus.publish(Operational.Warn, {
      traceId: "trace-preboot",
      time: Date.now(),
      component: "server",
      msg: "config invalid, using defaults",
    });

    Storage.initialize({ dbPath: ":memory:" });
    BusPersistence.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    stopBuffering();
    for (const [descriptor, data] of preBootEvents) Bus.publish(descriptor, data);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(journalRows()).toEqual([{ event_type: "operational.warn", trace_id: "trace-preboot" }]);
  });
});
