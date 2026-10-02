import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LedgerAction, type SessionGeneration, SessionTurn } from "@openomni/protocol";
import { createSessionKernel } from "../../../src/store/fence";
import { openCatalogStore } from "../../../src/store/catalog";
import { openSessionStore, SESSION_FILE_SCHEMA } from "../../../src/store/session-file";
import { runLedgerSync } from "../helpers/effect";
import { testNow } from "../helpers/storage";
import { expectBusyBeforeSchema, policyFixture } from "./store-fixtures";

function tableCensus(path: string): Array<{ name: string }> {
  const raw = new Database(path, { readonly: true });
  try {
    return raw
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
  } finally {
    raw.close();
  }
}

function turnIntentAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly generation: SessionGeneration.Snapshot;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: SessionTurn.HistoricalIntent.parse({
        phase: "intent",
        resultId: `${input.id}:result`,
        inboxIds: [],
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        resumeCount: 0,
        boundaryActionId: null,
      }),
    },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: 3,
  };
}

test("openSessionStore bootstraps a fresh session file: exactly the three session tables, WAL", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-store-"));
  const path = join(directory, "s1.sqlite");
  const store = openSessionStore(path, { now: testNow });
  try {
    expect(tableCensus(path)).toEqual([
      { name: "action" },
      { name: "decision_fact" },
      { name: "session" },
    ]);
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

// W5.2 review F9: busy_timeout is connection-local (it never touches the db
// file), so a non-SQLite payload makes the first file-touching statement throw
// NOTADB — observing busy_timeout=5000 after that throw proves the pragma ran
// strictly before any schema statement.
test("F9: session-file bootstrap applies busy_timeout before any schema statement", () => {
  expectBusyBeforeSchema(SESSION_FILE_SCHEMA);
});

test("openSessionStore rejects a corrupt payload instead of returning a handle", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-store-"));
  const path = join(directory, "notadb.sqlite");
  writeFileSync(path, "this file is deliberately not a sqlite database");
  try {
    expect(() => openSessionStore(path, { now: testNow })).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB", errno: 26 }),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("createSessionKernel serves session facts from the session file and policy rows from the catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-store-"));
  const session = openSessionStore(join(directory, "s1.sqlite"), { now: testNow });
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  try {
    const kernel = createSessionKernel(session, catalog);
    const created = runLedgerSync(
      kernel.materialize({
        id: "s1",
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 0,
        actionId: "s1:configure",
        at: 1,
      }),
    );
    expect(created.row).toMatchObject({ id: "s1", state: "idle" });

    const adopted = runLedgerSync(
      kernel.adoptFence({ sessionId: "s1", owner: "owner", fence: created.row.leaseFence + 1 }),
    );
    expect(adopted).toEqual({ ok: true, fence: 1 });

    const generation = kernel.latestGenerationFor("s1");
    const committed = runLedgerSync(
      kernel.commit({
        sessionId: "s1",
        owner: "owner",
        fence: adopted.fence,
        now: 3,
        expectedRevision: kernel.row("s1").revision,
        actions: [
          turnIntentAction({ id: "turn-1", sessionId: "s1", parentId: "s1:configure", generation }),
        ],
        state: "running",
      }),
    );
    expect(committed.ok).toBe(true);

    expect(kernel.verifyChain("s1")).toMatchObject({ kind: "intact", length: 2 });
    expect(kernel.getSnapshot("s1")).toMatchObject({
      id: "s1",
      state: "running",
      openTurnId: "turn-1",
    });
    expect(kernel.historyPage("s1").actions.map((action) => action.kind)).toEqual([
      "session.configure",
      "turn",
    ]);
    expect(kernel.latestFoldCheckpoint("s1")).toEqual({
      revision: kernel.row("s1").revision,
      checkpoint: undefined,
    });

    // Decision facts live inside the same per-session file.
    const outcome = session.decisionFacts.record({
      key: "k1",
      type: "test",
      data: { value: 1 },
      timeCreated: 4,
    });
    expect(outcome.kind).toBe("recorded");
    expect(session.decisionFacts.head("k1")?.rowHash).toBe(outcome.fact.rowHash);

    // Policy rows come from the catalog, not the session file.
    expect(
      catalog.policies.append(policyFixture),
    ).toBe(true);
    expect(kernel.policyRows()).toHaveLength(1);
    expect(kernel.currentPolicyGeneration()).toBe(1);

    // The inbox-table plane is gone (W5.2 #1197): pending work is a pure
    // projection over undelivered prompt actions, and a fresh file has none.
    expect(kernel.pendingMessages("s1")).toEqual([]);
  } finally {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true });
  }
});
