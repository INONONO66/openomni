/// <reference lib="es2022.object" />
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { LedgerSession } from "@openomni/protocol";
import * as ledgerExports from "../../src/index";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";

test("967 exports and production adapter expose only canonical session authority", () => {
  expect(Object.hasOwn(ledgerExports, "Session")).toBe(false);
  const adapter = new ledgerExports.SqliteStorageAdapter(":memory:");
  try {
    for (const retired of ["session", "message", "part"]) {
      expect(retired in adapter).toBe(false);
    }
    ledgerExports.Storage.assertComplete(adapter);
    for (const canonical of ["sessions", "actions", "inbox", "alarms"]) {
      expect(Object.hasOwn(adapter, canonical)).toBe(true);
    }
  } finally {
    adapter.close();
  }
});

// W5.2 review F6: the package index exports a narrow l0 write-kernel so no
// consumer needs deep imports for fenced commits or chain-hash verification.
test("L0Write commits a fenced action chained from the genesis hash", () => {
  const { L0Write } = ledgerExports;
  const db = new Database(":memory:");
  try {
    initializeSqliteDatabase(db);
    const row: LedgerSession.Row = {
      id: "surface-session",
      parentId: null,
      role: "resident",
      leaseOwner: "runner:surface",
      leaseFence: 1,
      leaseExpiresAt: 60_000,
      revision: 0,
      state: "idle",
      toolsGeneration: 0,
      systemHash: "",
      policyGeneration: 0,
    };
    expect(L0Write.insertSession(db, row)).toBe(true);
    expect(L0Write.selectSession(db, "surface-session")).toEqual(row);
    const result = L0Write.commitSession(
      db,
      {
        sessionId: "surface-session",
        owner: "runner:surface",
        fence: 1,
        now: 10,
        expectedRevision: 0,
        actions: [
          {
            id: "surface-turn",
            parentId: null,
            sessionId: "surface-session",
            kind: "turn",
            intent: { encodingVersion: 1, value: { phase: "terminal" } },
            effect: { encodingVersion: 1, value: { terminal: "result" } },
            irreversible: true,
            ts: 10,
          },
        ],
        consumeInboxIds: [],
        state: "idle",
        releaseLease: false,
      },
      (error) => {
        throw error;
      },
    );
    if (result?.ok !== true) throw new Error("surface commit was refused");
    const [receipt] = result.receipts;
    if (receipt === undefined) throw new Error("surface commit produced no receipt");
    expect(receipt.action.prevHash).toBe(L0Write.GENESIS_PREV_HASH);
    expect(receipt.action.actionHash).toBe(
      L0Write.computeActionHash({
        id: "surface-turn",
        parent_id: null,
        session_id: "surface-session",
        kind: "turn",
        intent: JSON.stringify({ phase: "terminal" }),
        effect: JSON.stringify({ terminal: "result" }),
        revert: null,
        irreversible: 1,
        encoding_version: 1,
        ts: 10,
        ordinal: 1,
        prev_hash: L0Write.GENESIS_PREV_HASH,
      }),
    );
    expect(result.row.revision).toBe(1);
  } finally {
    db.close();
  }
});
