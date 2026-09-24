import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLedgerSync } from "../helpers/effect";
import { SessionGeneration } from "@openomni/protocol";
import { initialize, SessionHandleStore, SqliteStorageAdapter, Storage } from "../../src";

test("new session creation persists canonical bundle selection across reopen", () =>
  Storage.withIsolation(() => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-bundles-"));
    const dbPath = join(directory, "sessions.db");
    const bundles = ["zeta", "audit-log"];
    try {
      initialize({ dbPath });
      runLedgerSync(
        SessionHandleStore.materialize({
          id: "selected",
          parentId: null,
          role: "resident",
          tools: [],
          bundles,
          system: { preset: "", blocks: [] },
          policyGeneration: 0,
          actionId: "selected:create",
          at: 1,
        }),
      );
      expect(SessionHandleStore.latestGenerationFor("selected").bundles).toEqual([
        "audit-log",
        "zeta",
      ]);
      expect(bundles).toEqual(["zeta", "audit-log"]);
      const actions = SessionHandleStore.tree("selected");
      Storage.reset();
      initialize({ dbPath });
      expect(SessionHandleStore.latestGenerationFor("selected").bundles).toEqual([
        "audit-log",
        "zeta",
      ]);
      expect(SessionHandleStore.tree("selected")).toEqual(actions);
      expect(SessionHandleStore.verifyChain("selected")).toMatchObject({
        kind: "intact",
        length: 1,
      });
    } finally {
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }));

test("historic configure bytes and hashes survive default empty bundle decoding and reopen", () =>
  Storage.withIsolation(() => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-historic-bundles-"));
    const dbPath = join(directory, "sessions.db");
    const historic = {
      generation: 1,
      revertTo: 0,
      tools: [],
      toolsHash: "historic-tools",
      systemPreset: "",
      systemBlocks: [],
      systemValue: "",
      systemHash: "historic-system",
      policyGeneration: 0,
    };
    const storage = new SqliteStorageAdapter(dbPath);
    Storage.configure(storage);
    try {
      runLedgerSync(
        storage.sessions.materialize({
          row: {
            id: "historic",
            parentId: null,
            role: "resident",
            state: "idle",
            revision: 0,
            leaseOwner: null,
            leaseFence: 0,
            leaseExpiresAt: null,
            toolsGeneration: 1,
            systemHash: historic.systemHash,
            policyGeneration: 0,
          },
          initialAction: {
            id: "historic:create",
            sessionId: "historic",
            parentId: null,
            kind: "session.configure",
            intent: { encodingVersion: 1, value: { operation: "create" } },
            effect: { encodingVersion: 1, value: { phase: "configured", snapshot: historic } },
            revert: { encodingVersion: 1, value: { generation: 0 } },
            ts: 1,
          },
        }),
      );
      const before = storage.testDatabase().query("SELECT effect, action_hash FROM action").get();
      const actions = storage.actions.tree("historic");
      expect(SessionHandleStore.latestGenerationFor("historic").bundles).toEqual([]);
      Storage.reset();
      const reopened = new SqliteStorageAdapter(dbPath);
      Storage.configure(reopened);
      expect(SessionHandleStore.latestGenerationFor("historic").bundles).toEqual([]);
      expect(reopened.testDatabase().query("SELECT effect, action_hash FROM action").get()).toEqual(
        before,
      );
      expect(reopened.actions.tree("historic")).toEqual(actions);
      expect(reopened.actions.verifyChain("historic")).toMatchObject({ kind: "intact", length: 1 });
      expect(SessionGeneration.Snapshot.parse(historic).bundles).toEqual([]);
    } finally {
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }));
