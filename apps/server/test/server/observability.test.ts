import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Operational } from "@openomni/protocol";
import { BusPersistence, BusQuery, Session, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createRouter } from "../../src/server/routes";

function db(): Database {
  return (Storage.getAdapter() as unknown as { readonly db: Database }).db;
}

async function flushBusPersistence(): Promise<void> {
  await BusPersistence.flush();
}

function insertWorkerRun(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}): void {
  db()
    .query(
      `INSERT INTO worker_run_state
       (run_id, session_id, parent_session_id, agent_name, status, title, prompt,
        resume_count, assigned_step_id, error, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.sessionId,
      null,
      "worker",
      input.status,
      `Run ${input.runId}`,
      "do the work",
      0,
      null,
      null,
      input.timeCreated,
      input.timeUpdated,
    );
}

describe("observability routes", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
    BusPersistence.start();
  });

  afterEach(() => {
    BusPersistence.stop();
    Bus.reset();
    Storage.reset();
  });

  test("session event journal endpoint reads BusQuery aggregates without exposing payload data", async () => {
    const app = createRouter(undefined, { observabilityToken: "test-token" });
    const session = Session.create({
      traceId: "trace-observability",
      title: "observability",
      model: { providerID: "test", modelID: "test-model" },
    });

    insertWorkerRun({
      runId: "run-observe",
      sessionId: session.id,
      status: "succeeded",
      timeCreated: 100,
      timeUpdated: 200,
    });

    Bus.publish(Operational.Events.Warn, {
      traceId: "trace-warn",
      sessionId: session.id,
      time: 100,
      component: "test",
      msg: "warn",
      context: { secret: "redacted by route" },
    });
    Bus.publish(Operational.Events.Error, {
      traceId: "trace-error",
      sessionId: session.id,
      time: 200,
      component: "test",
      msg: "error",
      error: "boom",
      context: { secret: "redacted by route" },
    });
    await flushBusPersistence();

    const res = await app.fetch(
      new Request(`http://localhost/observability/sessions/${session.id}/events`, {
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    const body = (await res.json()) as {
      sessionId: string;
      stats: { totalEvents: number; byCategory: Record<string, number> };
      errors: Array<{ eventType: string; traceId: string; timeCreated: number; data?: unknown }>;
      workerRuns: Array<{
        runId: string;
        status: string;
        eventCount: number;
        startTime: number;
        endTime: number;
      }>;
      chainIntegrity: { valid: boolean; totalVerified: number };
    };

    expect(res.status).toBe(200);
    expect(body.sessionId).toBe(session.id);
    expect(body.stats.totalEvents).toBe(3);
    expect(body.stats.byCategory.operational).toBe(2);
    expect(body.stats.byCategory.session).toBe(1);
    expect(body.errors).toEqual([
      {
        eventType: "operational.error",
        traceId: "trace-error",
        timeCreated: 200,
      },
    ]);
    expect(body.workerRuns).toEqual([
      {
        runId: "run-observe",
        status: "succeeded",
        eventCount: 0,
        startTime: 100,
        endTime: 200,
      },
    ]);
    expect(body.chainIntegrity.valid).toBe(true);
    expect(body.chainIntegrity.totalVerified).toBe(3);
  });

  test("fails closed: unconfigured or empty token denies 401 regardless of header", async () => {
    // Regression pin (auth-bypass audit): with an empty configured token,
    // `Bearer ${""}` is exactly "Bearer " — a header of "Bearer " must NOT
    // authorize. Undefined and "" tokens both deny every header shape.
    for (const options of [undefined, { observabilityToken: "" }]) {
      const app = createRouter(undefined, options);
      for (const headers of [
        undefined,
        { Authorization: "Bearer " },
        { Authorization: "Bearer any-token" },
      ]) {
        const res = await app.fetch(
          new Request("http://localhost/observability/sessions/session-1/events", { headers }),
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Unauthorized" });
      }
    }
  });

  test("session event journal endpoint rejects missing or wrong bearer tokens before querying storage", async () => {
    BusPersistence.stop();
    Storage.reset();

    const app = createRouter(undefined, { observabilityToken: "test-token" });

    const missingToken = await app.fetch(
      new Request("http://localhost/observability/sessions/session-1/events"),
    );
    const wrongToken = await app.fetch(
      new Request("http://localhost/observability/sessions/session-1/events", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );

    expect(missingToken.status).toBe(401);
    expect(await missingToken.json()).toEqual({ error: "Unauthorized" });
    expect(wrongToken.status).toBe(401);
    expect(await wrongToken.json()).toEqual({ error: "Unauthorized" });
  });

  test("session event journal endpoint does not expose storage errors", async () => {
    const app = createRouter(undefined, { observabilityToken: "test-token" });
    const getStats = BusQuery.getStats;

    Object.defineProperty(BusQuery, "getStats", {
      configurable: true,
      value: async () => {
        throw new Error("raw sqlite path /tmp/openomni.db");
      },
    });

    try {
      const res = await app.fetch(
        new Request("http://localhost/observability/sessions/session-1/events", {
          headers: { Authorization: "Bearer test-token" },
        }),
      );

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Observability query unavailable" });
    } finally {
      Object.defineProperty(BusQuery, "getStats", {
        configurable: true,
        value: getStats,
      });
    }
  });
});
