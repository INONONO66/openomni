import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BusPersistence,
  BusQuery,
  initialize,
  Session,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { startOpenOmni } from "../src/index";

const directories: string[] = [];
let stopApp: (() => void) | undefined;

function testConfig(dbPath: string) {
  return {
    dbPath,
    memoryPath: join(dbPath, "..", "memory.json"),
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

afterEach(() => {
  stopApp?.();
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
});
