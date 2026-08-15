import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { Bus, BusEvent } from "@openomni/telemetry";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import { WorkItemStore } from "../../src/work-item/index.js";
import "../../src/storage/initialize.js";

interface BusEventRow {
  readonly id: number;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly category: string;
  readonly visibility: string;
  readonly data: string;
  readonly trace_id: string;
  readonly duration_ms: number | null;
  readonly time_created: number;
}

function db(): Database {
  const descriptor = Object.getOwnPropertyDescriptor(Storage.getAdapter(), "db");
  if (descriptor?.value instanceof Database) return descriptor.value;
  throw new Error("Expected SQLite-backed storage adapter");
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
      visibility: "internal",
      trace_id: "trace-1",
      duration_ms: 123,
      time_created: time,
    });
    const firstCompleted = persisted[0];
    if (firstCompleted === undefined) throw new Error("shape");
    expect(JSON.parse(firstCompleted.data)).toEqual({
      sessionId: session.id,
      runId: "run-1",
      traceId: "trace-1",
      durationMs: 123,
      time,
      label: "ok",
    });
  });

  test("D11 pin: an untraceable event persists under the loud 'untraced' sentinel, never a minted trace", async () => {
    const session = createSession();
    const untraceable = BusEvent.define(
      "test.untraced.observed",
      z.object({ sessionId: z.string(), time: z.number() }),
    );
    const traced = BusEvent.define(
      "test.traced.observed",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number() }),
    );

    BusPersistence.start();
    Bus.publish(untraceable, { sessionId: session.id, time: Date.now() });
    Bus.publish(traced, { sessionId: session.id, traceId: "trace-verbatim", time: Date.now() });

    const persisted = await waitForRows(2);
    expect(persisted).toHaveLength(2);
    // Queryable absence: the sentinel is greppable in the ledger, and no
    // random mint launders the untraceable event into a plausible trace.
    const sentinelRows = db()
      .query("SELECT event_type FROM bus_event WHERE trace_id = 'untraced'")
      .all() as Array<{ event_type: string }>;
    expect(sentinelRows).toEqual([{ event_type: "test.untraced.observed" }]);
    const tracedRows = db()
      .query("SELECT event_type FROM bus_event WHERE trace_id = 'trace-verbatim'")
      .all() as Array<{ event_type: string }>;
    expect(tracedRows).toEqual([{ event_type: "test.traced.observed" }]);
  });

  test("persists schema-normalized payload defaults", async () => {
    const session = createSession();
    const time = Date.UTC(2026, 4, 10, 1, 2, 4);
    const event = BusEvent.define(
      "custom.normalized",
      z.object({
        sessionId: z.string().default(session.id),
        traceId: z.string().default("trace-from-schema"),
        time: z.number().default(time),
        label: z.string().default("normalized"),
      }),
    );

    BusPersistence.start();
    Bus.publish(event, {});

    const persisted = await waitForRows(1);
    expect(persisted[0]).toMatchObject({
      session_id: session.id,
      trace_id: "trace-from-schema",
      time_created: time,
    });
    const firstNormalized = persisted[0];
    if (firstNormalized === undefined) throw new Error("shape");
    expect(JSON.parse(firstNormalized.data)).toEqual({
      sessionId: session.id,
      traceId: "trace-from-schema",
      time,
      label: "normalized",
    });
  });

  test("falls back to raw payload when schema parsing fails", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "custom.parse_failed",
      z.object({
        sessionId: z.string(),
        traceId: z.string().default("trace-from-schema"),
        time: z.number(),
      }),
    );
    Object.defineProperty(event.schema, "safeParse", {
      value: () => {
        throw new Error("schema failed");
      },
    });

    BusPersistence.start();
    Bus.publish(event, {
      sessionId: session.id,
      traceId: "trace-raw",
      time: Date.UTC(2026, 4, 10, 1, 2, 6),
    });

    const persisted = await waitForRows(1);
    expect(persisted[0]).toMatchObject({
      session_id: session.id,
      trace_id: "trace-raw",
    });
    const firstRaw = persisted[0];
    if (firstRaw === undefined) throw new Error("shape");
    expect(JSON.parse(firstRaw.data)).toEqual({
      sessionId: session.id,
      traceId: "trace-raw",
      time: Date.UTC(2026, 4, 10, 1, 2, 6),
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

  test("group-commits a synchronous burst as one telemetry transaction", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "custom.batched",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number(), index: z.number() }),
    );

    BusPersistence.start();
    const transactionSpy = spyOn(db(), "transaction");
    try {
      for (let index = 0; index < 5; index += 1) {
        Bus.publish(event, {
          sessionId: session.id,
          traceId: `trace-batch-${index}`,
          time: Date.UTC(2026, 4, 10, 3, 0, index),
          index,
        });
      }
      // Rows are queued, not written per event — the batch commits on the
      // scheduled microtask flush (#510 D1 group commit).
      expect(rows()).toHaveLength(0);
      await BusPersistence.flush();
      expect(transactionSpy).toHaveBeenCalledTimes(1);
    } finally {
      transactionSpy.mockRestore();
    }

    const persisted = rows();
    expect(persisted).toHaveLength(5);
    expect(persisted.map((row) => JSON.parse(row.data).index)).toEqual([0, 1, 2, 3, 4]);
  });

  test("flush drains the queued batch on demand (shutdown drain)", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "custom.drained",
      z.object({ sessionId: z.string(), traceId: z.string(), time: z.number() }),
    );

    BusPersistence.start();
    Bus.publish(event, { sessionId: session.id, traceId: "trace-drain", time: Date.now() });
    expect(rows()).toHaveLength(0);

    await BusPersistence.flush();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ trace_id: "trace-drain" });
  });

  test("sanitizes non-finite trace timing fields before persistence", async () => {
    const session = createSession();
    const fallbackTime = Date.UTC(2026, 4, 10, 1, 2, 7);
    const event = BusEvent.define(
      "llm.call.completed",
      z.object({
        sessionId: z.string(),
        traceId: z.string(),
        durationMs: z.number(),
        time: z.number(),
      }),
    );

    BusPersistence.start({ now: () => new Date(fallbackTime) });
    Bus.publish(event, {
      sessionId: session.id,
      traceId: "trace-non-finite",
      durationMs: Number.NaN,
      time: Number.POSITIVE_INFINITY,
    });

    const persisted = await waitForRows(1);
    expect(persisted[0]).toMatchObject({
      session_id: session.id,
      trace_id: "trace-non-finite",
      duration_ms: null,
      time_created: fallbackTime,
    });
  });

  test("resolves events that use the legacy sessionID payload key for session-scoped queries", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "legacy.session_id.recorded",
      z.object({ sessionID: z.string(), marker: z.string() }),
    );

    BusPersistence.start();
    Bus.publish(event, { sessionID: session.id, marker: "m1" });
    const persisted = await waitForRows(1);

    expect(persisted.map((row) => row.event_type)).toEqual(["legacy.session_id.recorded"]);
    for (const row of persisted) {
      expect(row.session_id).toBe(session.id);
      expect(JSON.parse(row.data)).toEqual({ sessionID: session.id, marker: "m1" });
    }

    const sessionEvents = await BusQuery.listBySession(session.id);
    expect(sessionEvents.map((event) => event.eventType)).toEqual(["legacy.session_id.recorded"]);
  });

  test("resolves communication events by originSessionId and workerRunId", async () => {
    const session = createSession();
    // The worker-run store is frozen (#510 D2b) — the row is seeded at the
    // adapter layer, exactly as pre-freeze rows persist on disk.
    const workerRunAdapter = Storage.getAdapter().workerRunState;
    if (!workerRunAdapter) throw new Error("workerRunState sub-adapter missing");
    workerRunAdapter.create(session.id, {
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

  test("resolves workerRunId through the fact-backed WorkItem projection (no worker_run_state row)", async () => {
    // #510 D2b: new runs never write worker_run_state — the canonical read
    // for a run's session is the fact-bound WorkItem projection.
    const workSession = createSession();
    const item = await WorkItemStore.create(
      {
        name: "fact-backed-run",
        sourceMessageId: "msg_fact_backed_run",
        sourceChannel: "test",
        intent: "verify",
        goal: "resolve telemetry attribution from attempt facts",
        sessionId: "session-origin",
        acceptanceCriteria: ["session attribution rides the projection"],
      },
      "trace-test",
    );
    await WorkItemStore.assignExecution(
      item.hash,
      {
        executorKind: "internal_chat_agent",
        workerRunId: "worker-run-fact",
        workSessionId: workSession.id,
      },
      "trace-test",
    );
    const event = BusEvent.define(
      "worker_grant.evaluated",
      z.object({
        workerRunId: z.string(),
        traceId: z.string(),
        time: z.number(),
      }),
    );

    BusPersistence.start();
    Bus.publish(event, {
      workerRunId: "worker-run-fact",
      traceId: "trace-fact-backed",
      time: 3,
    });

    const persisted = await waitForRows(1);
    const grantRow = persisted.find((row) => row.event_type === "worker_grant.evaluated");
    expect(grantRow?.session_id).toBe(workSession.id);
  });

  test("continues when worker run session lookup fails", async () => {
    const event = BusEvent.define(
      "worker_grant.evaluated",
      z.object({
        workerRunId: z.string(),
        traceId: z.string(),
        time: z.number(),
      }),
    );
    db().query("DROP TABLE worker_run_state").run();

    BusPersistence.start();
    Bus.publish(event, {
      workerRunId: "missing-worker-run",
      traceId: "trace-worker-lookup-error",
      time: Date.UTC(2026, 4, 10, 1, 2, 9),
    });

    const persisted = await waitForRows(1);
    expect(persisted[0]).toMatchObject({
      session_id: null,
      trace_id: "trace-worker-lookup-error",
    });
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
        msg: "provider failed with token sk-secret",
        prompt: "summarize private user request",
        systemPrompt: "internal instruction text",
        messages: [{ role: "user", content: "secret prompt" }],
        generatedAt: new Date("2026-05-16T00:00:00.000Z"),
      },
    });
    await BusPersistence.flush();

    const redactRows = await waitForRows(1);
    const redactRow = redactRows[0];
    if (redactRow === undefined) throw new Error("shape");
    const data = JSON.parse(redactRow.data) as {
      context: {
        apiKey: string;
        credentials: string;
        error: unknown;
        err: unknown;
        input: unknown;
        msg: unknown;
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
    expect(data.context.msg).toEqual({ type: "string", length: 36 });
    expect(data.context.prompt).toEqual({ type: "string", length: 30 });
    expect(data.context.systemPrompt).toEqual({ type: "string", length: 25 });
    expect(data.context.messages).toEqual({ type: "array", length: 1 });
    expect(data.context.generatedAt).toBe("2026-05-16T00:00:00.000Z");
  });

  test("redacts cyclic payload references before persistence", async () => {
    const session = createSession();
    const context: Record<string, unknown> = {};
    context.self = context;
    context.child = { parent: context };
    const event = BusEvent.define(
      "policy.action.requested",
      z.object({
        sessionId: z.string(),
        traceId: z.string(),
        time: z.number(),
        context: z.unknown(),
      }),
    );

    BusPersistence.start();
    Bus.publish(event, {
      sessionId: session.id,
      traceId: "trace-cycle",
      time: Date.UTC(2026, 4, 10, 1, 2, 8),
      context,
    });

    const cycleRows = await waitForRows(1);
    const cycleRow = cycleRows[0];
    if (cycleRow === undefined) throw new Error("shape");
    const data = JSON.parse(cycleRow.data) as {
      context: { self: string; child: { parent: string } };
    };
    expect(data.context.self).toBe("[redacted]");
    expect(data.context.child.parent).toBe("[redacted]");
  });

  test("redacts operational context msg without overriding safe log message", async () => {
    const session = createSession();
    const event = BusEvent.define(
      "operational.error.model_resolution",
      z.object({
        sessionId: z.string(),
        traceId: z.string(),
        time: z.number(),
        component: z.string(),
        msg: z.string(),
        context: z.record(z.string(), z.unknown()),
      }),
    );
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });

    try {
      BusPersistence.start();
      Bus.publish(event, {
        sessionId: session.id,
        traceId: "trace-operational",
        time: Date.UTC(2026, 4, 10, 1, 2, 5),
        component: "model-resolution",
        msg: "safe operational summary",
        context: {
          msg: "provider failed with token sk-secret",
          apiKey: "sk-secret",
        },
      });
      await BusPersistence.flush();
    } finally {
      writeSpy.mockRestore();
    }

    const msgRows = await waitForRows(1);
    const msgRow = msgRows[0];
    if (msgRow === undefined) throw new Error("shape");
    const data = JSON.parse(msgRow.data) as {
      context: { msg: unknown; apiKey: string };
    };
    expect(data.context.msg).toEqual({ type: "string", length: 36 });
    expect(data.context.apiKey).toBe("[redacted]");
    expect(JSON.stringify(data)).not.toContain("sk-secret");

    const logLine = JSON.parse(stdout.trim()) as { msg: string; apiKey: string };
    expect(logLine.msg).toBe("safe operational summary");
    expect(logLine.apiKey).toBe("[redacted]");
    expect(stdout).not.toContain("sk-secret");
  });
});
