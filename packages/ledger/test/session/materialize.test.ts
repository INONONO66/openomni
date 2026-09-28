import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runLedgerSync } from "../helpers/effect";
import { materializeSession } from "../helpers/session";
import { useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("materialize");

describe("L0 session materialization", () => {
  test("repeat declaration preserves the existing row and generation", () => {
    const first = materializeSession(stores.kernel, "gateway-minted");
    const tree = sessionTree(first.id, stores.session.actions);
    const repeat = Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          stores.kernel.materialize({
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
    expect(sessionTree(first.id, stores.session.actions)).toEqual(tree);
  });

  test("reopens a parent-linked worker with identical generations, revision and tree", () => {
    materializeSession(stores.kernel, "resident-parent");
    const row = materializeSession(stores.kernel, "worker-child", "resident-parent");
    const tree = sessionTree(row.id, stores.session.actions);
    stores.reopen();
    expect(stores.kernel.row(row.id)).toEqual(row);
    expect(sessionTree(row.id, stores.session.actions)).toEqual(tree);
    expect(stores.kernel.getSnapshot(row.id)).toMatchObject({
      parentId: "resident-parent",
      role: "worker",
      revision: 1,
      toolsGeneration: 1,
    });
  });

  test("configuration failure rolls back both the session row and initial action", () => {
    const raw = new Database(stores.sessionPath);
    try {
      raw.exec(
        "CREATE TRIGGER refuse_configure BEFORE INSERT ON action BEGIN SELECT RAISE(ABORT, 'refuse configure'); END",
      );
      expect(() => materializeSession(stores.kernel, "refused")).toThrow(
        expect.objectContaining({ _tag: "ForeignFailure" }),
      );
      expect(raw.query("SELECT * FROM session").all()).toEqual([]);
      expect(sessionTree("refused", stores.session.actions)).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
