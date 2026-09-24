import { sessionTree } from "../helpers/session-tree";
import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionHandleStore, Storage } from "../../src/index";
import { materializeSession } from "../helpers/session";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

let dbPath: string;
beforeEach(() => {
  dbPath = tempDbPath("materialize");
  Storage.initialize({ dbPath });
});
afterEach(() => {
  Storage.reset();
  removeSqliteFiles(dbPath);
});

describe("L0 session materialization", () => {
  test("repeat declaration preserves the existing row and generation", () => {
    const first = materializeSession("gateway-minted");
    const tree = sessionTree(first.id);
    const repeat = Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          SessionHandleStore.materialize({
            id: first.id,
            parentId: null,
            role: "resident",
            tools: [],
            system: { preset: "different", blocks: [] },
            policyGeneration: 9,
            actionId: "must-not-append",
            at: 100,
          }),
        ),
      ),
      (error) => error,
    );
    expect(repeat).toEqual({ created: false, row: first });
    expect(sessionTree(first.id)).toEqual(tree);
  });

  test("promotes a historical nullable-role row without replacing its JSON", () => {
    const raw = new Database(dbPath);
    const legacy = JSON.stringify({ id: "legacy", expiresAt: 2, workerMeta: { lane: "archived" } });
    try {
      raw
        .query("INSERT INTO session (id, data, time_created, time_updated) VALUES (?, ?, 1, 1)")
        .run("legacy", legacy);
      expect(SessionHandleStore.listRows()).toEqual([]);
      expect(materializeSession("legacy")).toMatchObject({ role: "resident", revision: 1 });
      expect(sessionTree("legacy").map((action) => action.kind)).toEqual([
        "session.configure",
      ]);
      expect(raw.query("SELECT data FROM session WHERE id = ?").get("legacy")).toEqual({
        data: legacy,
      });
    } finally {
      raw.close();
    }
  });

  test("reopens a parent-linked worker with identical generations, revision and tree", () => {
    materializeSession("resident-parent");
    const row = materializeSession("worker-child", "resident-parent");
    const tree = sessionTree(row.id);
    Storage.reset();
    Storage.initialize({ dbPath });
    expect(SessionHandleStore.row(row.id)).toEqual(row);
    expect(sessionTree(row.id)).toEqual(tree);
    expect(SessionHandleStore.getSnapshot(row.id)).toMatchObject({
      parentId: "resident-parent",
      role: "worker",
      revision: 1,
      toolsGeneration: 1,
    });
  });

  test("configuration failure rolls back both promotion and initial action", () => {
    const raw = new Database(dbPath);
    try {
      raw
        .query(
          "INSERT INTO session (id, data, time_created, time_updated) VALUES ('legacy', '{}', 1, 1)",
        )
        .run();
      const before = raw.query("SELECT * FROM session").all();
      raw.exec(
        "CREATE TRIGGER refuse_configure BEFORE INSERT ON action BEGIN SELECT RAISE(ABORT, 'refuse configure'); END",
      );
      expect(() => materializeSession("legacy")).toThrow(
        expect.objectContaining({ _tag: "ForeignFailure" }),
      );
      expect(raw.query("SELECT * FROM session").all()).toEqual(before);
      expect(sessionTree("legacy")).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
