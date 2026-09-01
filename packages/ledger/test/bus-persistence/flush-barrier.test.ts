import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { BusEvent } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

function db(): Database {
  const descriptor = Object.getOwnPropertyDescriptor(Storage.get(), "db");
  if (descriptor?.value instanceof Database) return descriptor.value;
  throw new Error("Expected SQLite-backed storage adapter");
}

function rowCount(): number {
  const row = db().query("SELECT COUNT(*) AS n FROM bus_event").get() as { n: number };
  return row.n;
}

const first = BusEvent.define(
  "test.flush.first",
  z.object({ traceId: z.string(), time: z.number() }),
);
const second = BusEvent.define(
  "test.flush.second",
  z.object({ traceId: z.string(), time: z.number() }),
);

/**
 * flush() is the barrier a terminal path relies on right before
 * process.exit(): after it resolves, every row implied by publishes that
 * happened before the call must be committed — process death must not be
 * able to drop them. No extra microtask turns or timers are allowed here;
 * the exit path won't grant any.
 */
describe("BusPersistence.flush as a pre-exit barrier", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    BusPersistence.stop();
    Bus.reset();
    Storage.reset();
  });

  test("a publish immediately followed by flush() is committed when flush resolves", async () => {
    BusPersistence.start();
    Bus.publish(first, { traceId: "trace-barrier-1", time: Date.now() });

    await BusPersistence.flush();

    expect(rowCount()).toBe(1);
  });

  test("a cascade published by a subscriber is committed when flush resolves", async () => {
    BusPersistence.start();
    // A subscriber that reacts to the first event by publishing a second —
    // the shape of every "on terminal, record a follow-up" hook. Its row is
    // implied by the pre-flush publish and must be inside the barrier.
    const unsubscribe = Bus.subscribe(first, () => {
      Bus.publish(second, { traceId: "trace-barrier-2", time: Date.now() });
    });

    try {
      Bus.publish(first, { traceId: "trace-barrier-1", time: Date.now() });

      await BusPersistence.flush();

      expect(rowCount()).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  test("a multi-level cascade is committed when flush resolves", async () => {
    BusPersistence.start();
    // Depth 8 discriminates the barrier: the old one-turn flush committed
    // exactly the first 5 rows at ANY depth (its internal await hops granted
    // ~5 ambient microtask turns), so a shallower chain passes vacuously.
    const DEPTH = 8;
    const chain = Array.from({ length: DEPTH + 1 }, (_, depth) =>
      BusEvent.define(
        `test.flush.deep.${depth}`,
        z.object({ traceId: z.string(), time: z.number() }),
      ),
    );
    const unsubscribes = chain.slice(0, DEPTH).map((event, depth) =>
      Bus.subscribe(event as BusEvent.Descriptor<{ traceId: string; time: number }>, () => {
        Bus.publish(chain[depth + 1] as BusEvent.Descriptor<{ traceId: string; time: number }>, {
          traceId: `trace-deep-${depth + 1}`,
          time: Date.now(),
        });
      }),
    );

    try {
      Bus.publish(chain[0] as BusEvent.Descriptor<{ traceId: string; time: number }>, {
        traceId: "trace-deep-0",
        time: Date.now(),
      });

      await BusPersistence.flush();

      expect(rowCount()).toBe(DEPTH + 1);
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
    }
  });

  test("a pathological cascade yields at the bounded quiescence limit", async () => {
    BusPersistence.start();
    const depth = 256;
    const chain = Array.from({ length: depth + 1 }, (_, index) =>
      BusEvent.define(
        `test.flush.bounded.${index}`,
        z.object({ traceId: z.string(), time: z.number() }),
      ),
    );
    const unsubscribes = chain.slice(0, depth).map((event, index) =>
      Bus.subscribe(event as BusEvent.Descriptor<{ traceId: string; time: number }>, () => {
        Bus.publish(chain[index + 1] as BusEvent.Descriptor<{ traceId: string; time: number }>, {
          traceId: `trace-bounded-${index + 1}`,
          time: Date.now(),
        });
      }),
    );

    Bus.publish(chain[0] as BusEvent.Descriptor<{ traceId: string; time: number }>, {
      traceId: "trace-bounded-0",
      time: Date.now(),
    });
    await BusPersistence.flush();
    const committedAtBound = rowCount();
    for (const unsubscribe of unsubscribes) unsubscribe();
    await BusPersistence.flush();

    expect(committedAtBound).toBeGreaterThan(0);
    expect(committedAtBound).toBeLessThan(depth + 1);
    expect(rowCount()).toBeGreaterThanOrEqual(committedAtBound);
  });

  test("flush() before start and after stop resolves without touching storage", async () => {
    await BusPersistence.flush();

    BusPersistence.start();
    Bus.publish(first, { traceId: "trace-barrier-3", time: Date.now() });
    await BusPersistence.flush();
    BusPersistence.stop();

    await BusPersistence.flush();
    expect(rowCount()).toBe(1);
  });
});
