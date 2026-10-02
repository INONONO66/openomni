import { sessionTree } from "../helpers/session-tree";
import { describe, expect, test } from "bun:test";
import { materializeSession } from "../helpers/session";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();

describe("canonical session lineage", () => {
  test("children and grandchildren retain distinct direct parents", () => {
    const kernel = stores.kernel;
    const root = materializeSession(kernel, "root");
    const child = materializeSession(kernel, "child", root.id);
    const grandchild = materializeSession(kernel, "grandchild", child.id);
    expect(kernel.row(root.id).parentId).toBeNull();
    expect(kernel.getSnapshot(child.id)).toMatchObject({
      parentId: root.id,
      role: "worker",
    });
    expect(kernel.getSnapshot(grandchild.id)).toMatchObject({
      parentId: child.id,
      role: "worker",
    });
    expect(
      kernel
        .listRows()
        .filter((row) => row.parentId === root.id)
        .map((row) => row.id),
    ).toEqual([child.id]);
  });

  test("kernel child-session pages read the catalog index in id order", () => {
    for (const [id, parentId] of [
      ["b", "root"],
      ["a", "root"],
      ["else", "other"],
    ] as const) {
      stores.catalog.indexSession({ id, parentId, role: "worker", createdAt: 1 });
    }
    expect(stores.kernel.childSessionsPage("root", "", 256).map((row) => row.id)).toEqual([
      "a",
      "b",
    ]);
    expect(stores.kernel.childSessionsPage("root", "a", 256).map((row) => row.id)).toEqual(["b"]);
  });

  test("external parent identity is retained without inventing a parent row", () => {
    // L0 parent_id is a provenance reference, not a parent-existence admission policy.
    materializeSession(stores.kernel, "child", "external-parent");
    expect(stores.kernel.row("child").parentId).toBe("external-parent");
    expect(stores.kernel.listRows().map((row) => row.id)).toEqual(["child"]);
    expect(sessionTree("external-parent", stores.session.actions)).toEqual([]);
  });
});
