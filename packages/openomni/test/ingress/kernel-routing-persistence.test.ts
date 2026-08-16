import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusPersistence, Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import {
  createMappedOwnerSession,
  ownerEvent,
  registerOwnerDm,
  kernelEngine,
  makeKernelRoutingEngine,
} from "./_kernel-routing-fixture";

describe("IngressEngine routing decision persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    // File-backed storage (instead of the fixture's :memory: reset) so the
    // test can read the persisted bus_event rows over an independent
    // connection — BusQuery exposes no production event-listing surface.
    tmpDir = mkdtempSync(join(tmpdir(), "kernel-routing-persistence-"));
    dbPath = join(tmpDir, "test.db");
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath });
    makeKernelRoutingEngine();
  });

  afterEach(() => {
    BusPersistence.stop();
    Storage.reset();
    Bus.reset();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("persists the non-ephemeral decision through BusPersistence", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();
    BusPersistence.start();

    // When
    await kernelEngine().ingest(ownerEvent);
    await BusPersistence.flush();

    // Then
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query<
          { session_id: string; event_type: string; visibility: string; data: string },
          [string, string]
        >(
          "SELECT session_id, event_type, visibility, data FROM bus_event WHERE session_id = ? AND event_type = ?",
        )
        .all(mappedSession.id, "ingress.routing.decision");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("asserted length above");
      expect(row.visibility).toBe("user_audit");
      expect(JSON.parse(row.data)).toMatchObject({
        inboundId: ownerEvent.id,
        stage: "surface_default",
        outcome: "route",
        sessionId: mappedSession.id,
      });
    } finally {
      db.close();
    }
  });
});
