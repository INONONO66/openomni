import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
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
  test("main() keeps the microtask turn between persistence start and republish", () => {
    // Binds the pin to the bootstrap source (repo precedent:
    // context/integration.test.ts): the sequence pin below locks the Bus
    // mechanism, but a future edit deleting the await from main() would
    // regress silently without this.
    const bootstrapSrc = readFileSync(
      new URL("../../src/bootstrap/index.ts", import.meta.url),
      "utf8",
    );
    const startIndex = bootstrapSrc.indexOf("BusPersistence.start();");
    const republishIndex = bootstrapSrc.indexOf("of preBootEvents) Bus.publish");
    expect(startIndex).toBeGreaterThan(-1);
    expect(republishIndex).toBeGreaterThan(startIndex);
    expect(bootstrapSrc.slice(startIndex, republishIndex)).toContain("queueMicrotask");
  });

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
