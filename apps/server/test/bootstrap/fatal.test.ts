import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BusPersistence, Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { reportFatalAndExit } from "../../src/bootstrap/fatal";

function busEventRows(): Array<{ event_type: string; data: string }> {
  const descriptor = Object.getOwnPropertyDescriptor(Storage.getAdapter(), "db");
  if (!(descriptor?.value instanceof Database)) {
    throw new Error("Expected SQLite-backed storage adapter");
  }
  return descriptor.value
    .query("SELECT event_type, data FROM bus_event ORDER BY id ASC")
    .all() as Array<{ event_type: string; data: string }>;
}

describe("reportFatalAndExit", () => {
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

  test("the fatal row is committed before exit is invoked", async () => {
    BusPersistence.start();

    let rowsAtExit: number | undefined;
    let exitCode: number | undefined;
    await reportFatalAndExit(new Error("boot exploded"), (code) => {
      exitCode = code;
      rowsAtExit = busEventRows().length;
    });

    // The whole point of the barrier: at the moment process.exit would have
    // run — discarding every queued microtask — the row is already on disk.
    expect(exitCode).toBe(1);
    expect(rowsAtExit).toBe(1);
    const row = busEventRows()[0];
    expect(row?.event_type).toBe("operational.error");
    // Free-text fields are redacted to shape descriptors before persistence;
    // the pin is the barrier (row committed at exit time), not the prose.
    const data = JSON.parse(row?.data ?? "{}") as Record<string, unknown>;
    expect(data.msg).toBeDefined();
    expect(data.context).toBeDefined();
  });

  test("exits even when persistence never started", async () => {
    let exitCode: number | undefined;
    await reportFatalAndExit("string failure", (code) => {
      exitCode = code;
    });
    expect(exitCode).toBe(1);
  });
});
