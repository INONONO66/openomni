import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Bus, BusEvent } from "../../src/bus/index.js";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

interface BusEventRow {
  readonly id: number;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly category: string;
  readonly data: string;
  readonly trace_id: string;
  readonly duration_ms: number | null;
  readonly time_created: number;
}

function db(): Database {
  return (Storage.getAdapter() as unknown as { readonly db: Database }).db;
}

function rows(): BusEventRow[] {
  return db().query("SELECT * FROM bus_event ORDER BY id ASC").all() as BusEventRow[];
}

async function flushPersistence(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRows(expectedCount: number): Promise<BusEventRow[]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = rows();
    if (current.length >= expectedCount) return current;
    await flushPersistence();
  }
  return rows();
}

function createSession(): ReturnType<typeof Session.create> {
  return Session.create({
    title: "bus persistence",
    model: { providerID: "test", modelID: "test-model" },
  });
}

describe("BusPersistence", () => {
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

  test("persists non-ephemeral bus events", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "llm.call.completed",
      z.object({
        sessionId: z.string(),
        runId: z.string(),
        traceId: z.string(),
        durationMs: z.number(),
        time: z.number(),
        label: z.string(),
      }),
    );
    const time = Date.UTC(2026, 4, 10, 1, 2, 3);

    BusPersistence.start();
    Bus.publish(event, {
      sessionId: session.id,
      runId: "run-1",
      traceId: "trace-1",
      durationMs: 123,
      time,
      label: "ok",
    });

    const persisted = await waitForRows(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      session_id: session.id,
      run_id: "run-1",
      event_type: "llm.call.completed",
      category: "llm",
      trace_id: "trace-1",
      duration_ms: 123,
      time_created: time,
    });
    expect(JSON.parse(persisted[0].data)).toEqual({
      sessionId: session.id,
      runId: "run-1",
      traceId: "trace-1",
      durationMs: 123,
      time,
      label: "ok",
    });
  });

  test("skips ephemeral bus events", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "custom.ephemeral",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number() }),
      { visibility: "ephemeral" },
    );

    BusPersistence.start();
    Bus.publish(event, { sessionId: session.id, traceId: "trace-ephemeral", time: Date.now() });
    await flushPersistence();

    expect(rows()).toEqual([]);
  });

  test("preserves publish order for multiple events in one session", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "agent.step.completed",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number(), index: z.number() }),
    );

    BusPersistence.start();
    for (let index = 0; index < 5; index += 1) {
      Bus.publish(event, {
        sessionId: session.id,
        traceId: `trace-${index}`,
        time: Date.UTC(2026, 4, 10, 2, 0, index),
        index,
      });
    }

    const persisted = await waitForRows(5);
    expect(persisted).toHaveLength(5);
    expect(persisted.map((row) => JSON.parse(row.data).index)).toEqual([0, 1, 2, 3, 4]);
    expect(persisted.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("observer errors do not crash publishers", async () => {
    const event = BusEvent.define(
      "llm.call.completed",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number() }),
    );
    let warning: unknown;
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warning = args;
    };

    try {
      BusPersistence.start({ resolveSessionId: () => "missing-session" });
      expect(() => {
        Bus.publish(event, {
          sessionId: "missing-session",
          traceId: "trace-error",
          time: Date.now(),
        });
      }).not.toThrow();
      await flushPersistence();

      expect(rows()).toEqual([]);
      expect(warning).toBeDefined();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("stop unregisters the observer", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "custom.persisted",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number() }),
    );

    BusPersistence.start();
    Bus.publish(event, { sessionId: session.id, traceId: "trace-before", time: Date.now() });
    expect(await waitForRows(1)).toHaveLength(1);

    BusPersistence.stop();
    Bus.publish(event, { sessionId: session.id, traceId: "trace-after", time: Date.now() });
    await flushPersistence();

    expect(rows()).toHaveLength(1);
  });
});
