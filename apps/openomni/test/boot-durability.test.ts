import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  BusPersistence,
  BusQuery,
  DelegationStore,
  initialize,
  Session,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import { Delegation, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { startOpenOmni } from "../src/index";

const directories: string[] = [];
let stopApp: (() => Promise<void>) | undefined;

/** Bounds an awaited exact signal; the timeout only ever fails the test. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

function testConfig(dbPath: string) {
  return {
    dbPath,
    host: "127.0.0.1",
    wsPort: 0,
    model: { provider: "fake", id: "boot-test", apiKey: "test-key" },
  };
}

function newDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openomni-boot-durability-"));
  directories.push(directory);
  return join(directory, "openomni.db");
}

afterEach(async () => {
  await stopApp?.();
  stopApp = undefined;
  BusPersistence.stop();
  Bus.reset();
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenOmni boot durability", () => {
  test("starts the bus journal so a non-ephemeral event is queryable", async () => {
    const dbPath = newDatabasePath();
    const app = await startOpenOmni({ config: testConfig(dbPath) });
    stopApp = app.stop;

    const session = Session.create({
      traceId: "trace-journal-session",
      title: "journal boot proof",
      model: { providerID: "fake", modelID: "boot-test" },
    });
    Bus.publish(Operational.Events.Error, {
      traceId: "trace-journal-boot",
      sessionId: session.id,
      time: 1_000,
      component: "boot-test",
      msg: "journal proof",
      error: "proof error",
    });
    await BusPersistence.flush();

    await expect(BusQuery.listErrors(session.id)).resolves.toEqual([
      expect.objectContaining({
        eventType: "operational.error",
        traceId: "trace-journal-boot",
      }),
    ]);
  });

  test("expires an overdue open Wait during boot recovery", async () => {
    const dbPath = newDatabasePath();
    initialize({ dbPath });
    WaitStore.create(
      {
        id: "wait-expired-on-boot",
        ownerRef: { kind: "workItem", id: "work-1" },
        originMessageId: "message-1",
        correlation: { endpointId: "ws:actor-1", replyToMessageId: "message-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-1"],
        resolutionPolicy: "first_reply",
        expiresAt: 1,
        followUpWindow: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      "trace-seed-expired-wait",
    );
    Storage.reset();

    const app = await startOpenOmni({ config: testConfig(dbPath) });
    stopApp = app.stop;

    expect(WaitStore.get("wait-expired-on-boot")).toMatchObject({
      status: "expired",
      partial: false,
    });
  });

  test("sweeps an expired session during boot recovery", async () => {
    const dbPath = newDatabasePath();
    initialize({ dbPath });
    const expired = Session.create({
      traceId: "trace-seed-expired-session",
      title: "expired boot proof",
      model: { providerID: "fake", modelID: "boot-test" },
      ttlMs: -1000,
    });
    Storage.reset();

    const app = await startOpenOmni({ config: testConfig(dbPath) });
    stopApp = app.stop;

    // The sweep is a physical removal, not a read-time filter: the row is gone.
    expect(Storage.get().session.get(expired.id)).toBeUndefined();
  });

  test("reports a failed boot-rescanned wake through the queued path and leaves no receipt", async () => {
    const dbPath = newDatabasePath();
    initialize({ dbPath });
    const origin = Session.create({
      traceId: "trace-seed-wake-origin",
      title: "wake origin",
      model: { providerID: "fake", modelID: "boot-test" },
    });
    DelegationStore.create(
      Delegation.Record.parse({
        delegationId: "delegation-1",
        operation: "ask",
        address: { kind: "actor", actorId: "actor-1" },
        transport: "channel",
        deadline: 10_000,
        waitId: "wait-1",
        rootDelegationId: "delegation-1",
        origin: { role: "resident", depth: 0, sessionId: origin.id },
        instruction: "Summarize the proposal.",
        status: "open",
        createdAt: 100,
      }),
    );
    DelegationStore.settleOnce("delegation-1", {
      status: "completed",
      delegationId: "delegation-1",
      output: "done",
      at: 200,
    });
    Storage.reset();

    const wakeErrors: unknown[] = [];
    let sawWakeError!: () => void;
    const firstWakeError = new Promise<void>((resolve) => {
      sawWakeError = resolve;
    });
    Bus.subscribe(Operational.Events.Error, (data) => {
      if (data.context?.delegationId === "delegation-1") {
        wakeErrors.push(data);
        sawWakeError();
      }
    });

    const app = await startOpenOmni({
      config: testConfig(dbPath),
      llm: {
        resolveProviderModel: async (model) => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
        }),
        // "validation" classifies non-retryable, so the turn rejects at once.
        run: async () => {
          throw new Error("validation: wake delivery disabled for this test");
        },
      },
    });
    stopApp = app.stop;

    // The rescan wake arrives during recovery — before the delivery queue is
    // armed — so it takes the queued path end to end. Exactly-once publishing
    // is NOT asserted here: the kernel's reportFailure sits two promise hops
    // downstream of any composition-root publish, so no app-level count is
    // deterministic — wake-delivery.test.ts pins it via wake-promise settlement.
    await bounded(firstWakeError, 5_000, "wake failure event");
    expect(wakeErrors[0]).toMatchObject({
      component: "delegation",
      msg: "delegation wake failed for delegation-1",
    });
    // The failure left no receipt: the row stays settled-unwoken for the next boot.
    expect(DelegationStore.get("delegation-1")?.wokenAt).toBeUndefined();
  });

  test("stop flushes the bus journal before storage resets", async () => {
    const dbPath = newDatabasePath();
    const app = await startOpenOmni({ config: testConfig(dbPath) });

    const session = Session.create({
      traceId: "trace-shutdown-flush-session",
      title: "shutdown flush proof",
      model: { providerID: "fake", modelID: "boot-test" },
    });
    Bus.publish(Operational.Events.Error, {
      traceId: "trace-shutdown-flush",
      sessionId: session.id,
      time: 1_000,
      component: "boot-test",
      msg: "shutdown flush proof",
      error: "proof error",
    });

    // No explicit flush: the shutdown contract owes the drain.
    await app.stop();

    initialize({ dbPath });
    await expect(BusQuery.listErrors(session.id)).resolves.toEqual([
      expect.objectContaining({
        eventType: "operational.error",
        traceId: "trace-shutdown-flush",
      }),
    ]);
  });

  test("boot rollback flushes pending journal writes before storage resets", async () => {
    const dbPath = newDatabasePath();
    initialize({ dbPath });
    WaitStore.create(
      {
        id: "wait-expired-during-failed-boot",
        ownerRef: { kind: "workItem", id: "work-rollback" },
        originMessageId: "message-rollback",
        correlation: { endpointId: "ws:actor-1", replyToMessageId: "message-rollback" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-1"],
        resolutionPolicy: "first_reply",
        expiresAt: 1,
        followUpWindow: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      "trace-seed-rollback-wait",
    );
    Storage.reset();
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const occupiedPort = blocker.port;
    if (occupiedPort === undefined) throw new Error("blocker server did not bind a port");

    await expect(
      startOpenOmni({ config: { ...testConfig(dbPath), wsPort: occupiedPort } }),
    ).rejects.toThrow();
    blocker.stop();

    const database = new Database(dbPath, { readonly: true });
    try {
      const row = database
        .query("SELECT event_type FROM bus_event WHERE event_type = 'wait.expired'")
        .get() as { event_type: string } | null;
      expect(row?.event_type).toBe("wait.expired");
    } finally {
      database.close();
    }
  });

  test("rolls back the bus journal and storage when boot fails after journaling started", async () => {
    const dbPath = newDatabasePath();
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const occupiedPort = blocker.port;
    if (occupiedPort === undefined) throw new Error("blocker server did not bind a port");

    const observersBefore = Bus.stats().observerCount;
    await expect(
      startOpenOmni({ config: { ...testConfig(dbPath), wsPort: occupiedPort } }),
    ).rejects.toThrow();
    blocker.stop();

    // Fail-closed rollback: the journal observer is detached and storage is
    // torn down, so a failed boot leaks no writer and poisons no later boot.
    expect(Bus.stats().observerCount).toBe(observersBefore);
    expect(() => Storage.get()).toThrow();

    const app = await startOpenOmni({ config: testConfig(dbPath) });
    stopApp = app.stop;
  });
});
