import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Bus, BusEvent } from "../../src/bus/index.js";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { Session } from "../../src/session/index.js";
import { WorkerRunStateStore } from "../../src/worker-run/state-store.js";
import { Snapshot } from "../../src/snapshot/index.js";
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
    Snapshot.reset();
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

  test("resolves snapshot events that use sessionID for session-scoped queries", async () => {
    const session = createSession();

    BusPersistence.start();
    const snapshotID = Snapshot.track(session.id);
    Snapshot.restore(session.id, snapshotID);
    const persisted = await waitForRows(2);

    expect(persisted.map((row) => row.event_type)).toEqual([
      "snapshot.tracked",
      "snapshot.restored",
    ]);
    for (const row of persisted) {
      expect(row.session_id).toBe(session.id);
      expect(JSON.parse(row.data)).toEqual({ sessionID: session.id, snapshotID });
    }
    expect(persisted[0]).toMatchObject({
      session_id: session.id,
      event_type: "snapshot.tracked",
      category: "snapshot",
    });

    const sessionEvents = await BusQuery.listBySession(session.id);
    expect(sessionEvents.map((event) => event.eventType).sort()).toEqual([
      "snapshot.restored",
      "snapshot.tracked",
    ]);
  });

  test("resolves communication events by originSessionId and workerRunId", async () => {
    const session = createSession();
    WorkerRunStateStore.create(session.id, {
      runId: "worker-run-1",
      agentName: "worker",
      status: "running",
      title: "worker",
      prompt: "work",
    });
    const pendingAskEvent = BusEvent.define(
      "pending_ask.opened",
      z.object({
        id: z.string(),
        originSessionId: z.string(),
        traceId: z.string(),
        time: z.number(),
      }),
    );
    const workerGrantEvent = BusEvent.define(
      "worker_grant.evaluated",
      z.object({
        id: z.string(),
        workerRunId: z.string(),
        traceId: z.string(),
        time: z.number(),
      }),
    );

    BusPersistence.start();
    Bus.publish(pendingAskEvent, {
      id: "ask-1",
      originSessionId: session.id,
      traceId: "trace-ask",
      time: 1,
    });
    Bus.publish(workerGrantEvent, {
      id: "grant-1",
      workerRunId: "worker-run-1",
      traceId: "trace-grant",
      time: 2,
    });

    const persisted = await waitForRows(2);
    expect(persisted.map((row) => row.session_id)).toEqual([session.id, session.id]);
    expect(persisted.map((row) => row.event_type)).toEqual([
      "pending_ask.opened",
      "worker_grant.evaluated",
    ]);
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

  test("redacts sensitive and raw payload fields before persistence", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "policy.action.requested",
      z.object({
        sessionId: z.string(),
        traceId: z.string(),
        time: z.number(),
        context: z.record(z.string(), z.unknown()),
      }),
    );

    BusPersistence.start();
    Bus.publish(event, {
      sessionId: session.id,
      traceId: "trace-redact",
      time: Date.now(),
      context: {
        apiKey: "secret",
        credentials: { anthropic: "sk-secret" },
        error: "provider failed with prompt text and token secret",
        err: "raw stack includes api key",
        input: { command: "printenv DISCORD_BOT_TOKEN" },
        prompt: "summarize private user request",
        systemPrompt: "internal instruction text",
        messages: [{ role: "user", content: "secret prompt" }],
        generatedAt: new Date("2026-05-16T00:00:00.000Z"),
      },
    });
    await BusPersistence.flush();

    const data = JSON.parse((await waitForRows(1))[0].data) as {
      context: {
        apiKey: string;
        credentials: string;
        error: unknown;
        err: unknown;
        input: unknown;
        prompt: unknown;
        systemPrompt: unknown;
        messages: unknown;
        generatedAt: string;
      };
    };
    expect(data.context.apiKey).toBe("[redacted]");
    expect(data.context.credentials).toBe("[redacted]");
    expect(data.context.error).toEqual({ type: "string", length: 49 });
    expect(data.context.err).toEqual({ type: "string", length: 26 });
    expect(data.context.input).toEqual({ type: "object", keys: ["command"] });
    expect(data.context.prompt).toEqual({ type: "string", length: 30 });
    expect(data.context.systemPrompt).toEqual({ type: "string", length: 25 });
    expect(data.context.messages).toEqual({ type: "array", length: 1 });
    expect(data.context.generatedAt).toBe("2026-05-16T00:00:00.000Z");
  });
});
