import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { extractSurfaceKey } from "@openomni/protocol";
import { BusPersistence, Session, Storage, SurfaceKey } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createGatewayRouter, type GatewayRouter } from "../../src/router/index.js";
import { ownerEvent, registerOwnerDm } from "./_router-fixture";

/**
 * Unlike the shared fixture's fabricated-UUID surface claim (enough for the
 * router, which never reads session rows), THIS test asserts a persisted
 * bus_event row whose session_id carries an FK to session(id) — so the mapped
 * session must exist as a real row for BusPersistence to bind the decision.
 */
function createMappedOwnerSession(): { readonly id: string } {
  const session = Session.create({
    traceId: "trace-test",
    title: "Owner DM",
    model: { providerID: "test", modelID: "test-model" },
  });
  SurfaceKey.claim(extractSurfaceKey(ownerEvent), session.id);
  return session;
}

describe("GatewayRouter routing decision persistence", () => {
  let tmpDir: string;
  let dbPath: string;
  let router: GatewayRouter;

  beforeEach(() => {
    // File-backed storage (instead of the shared fixture's :memory: reset) so
    // the test can read the persisted bus_event rows over an independent
    // connection — BusQuery exposes no production event-listing surface.
    tmpDir = mkdtempSync(join(tmpdir(), "kernel-routing-persistence-"));
    dbPath = join(tmpDir, "test.db");
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath });
    router = createGatewayRouter({
      sink: (event, data) => {
        Bus.publish(event, data);
      },
      deliver: async (delivery) => ({
        mode: "direct",
        target: delivery.event.target ?? { kind: "resident" },
        sessionId: delivery.sessionId ?? "unrouted-session",
        result: { output: "resident response", finishReason: "stop" },
      }),
    });
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
    await router.ingest(ownerEvent);
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
