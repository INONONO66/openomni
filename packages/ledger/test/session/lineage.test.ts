import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "../../src/index";
import { materializeSession } from "../helpers/session";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

describe("canonical session lineage", () => {
  test("children and grandchildren retain distinct direct parents", () => {
    const root = materializeSession("root");
    const child = materializeSession("child", root.id);
    const grandchild = materializeSession("grandchild", child.id);
    expect(SessionHandleStore.row(root.id).parentId).toBeNull();
    expect(SessionHandleStore.getSnapshot(child.id)).toMatchObject({
      parentId: root.id,
      role: "worker",
    });
    expect(SessionHandleStore.getSnapshot(grandchild.id)).toMatchObject({
      parentId: child.id,
      role: "worker",
    });
    expect(
      SessionHandleStore.listRows()
        .filter((row) => row.parentId === root.id)
        .map((row) => row.id),
    ).toEqual([child.id]);
  });

  test("external parent identity is retained without inventing a parent row", () => {
    // L0 parent_id is a provenance reference, not a parent-existence admission policy.
    materializeSession("child", "external-parent");
    expect(SessionHandleStore.row("child").parentId).toBe("external-parent");
    expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["child"]);
    expect(SessionHandleStore.tree("external-parent")).toEqual([]);
  });
});
