import { beforeEach, describe, expect, test } from "bun:test";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

describe("Session lineage APIs", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("createChild links to parent and increments spawnDepth", () => {
    const parent = Session.create({
      traceId: "trace-lineage",
      title: "Parent",
      model: { providerID: "test", modelID: "parent-model" },
    });

    const child = Session.createChild({
      traceId: "trace-lineage",
      parentSessionId: parent.id,
      title: "Child",
      model: { providerID: "test", modelID: "child-model" },
    });

    expect(child.parentSessionId).toBe(parent.id);
    expect(child.spawnDepth).toBe(1);
    expect(Session.get(child.id)?.parentSessionId).toBe(parent.id);
    expect(Session.get(child.id)?.spawnDepth).toBe(1);
  });

  test("listChildren returns only direct children", () => {
    const parent = Session.create({
      traceId: "trace-lineage",
      title: "Parent",
      model: { providerID: "test", modelID: "parent-model" },
    });

    const child = Session.createChild({
      traceId: "trace-lineage",
      parentSessionId: parent.id,
      title: "Child",
      model: { providerID: "test", modelID: "child-model" },
    });

    const grandchild = Session.createChild({
      traceId: "trace-lineage",
      parentSessionId: child.id,
      title: "Grandchild",
      model: { providerID: "test", modelID: "grandchild-model" },
    });

    const children = Session.listChildren(parent.id);
    expect(children.map((session) => session.id)).toEqual([child.id]);
    expect(children.find((session) => session.id === grandchild.id)).toBeUndefined();
  });

  test("createChild increments spawnDepth from parent depth", () => {
    const root = Session.create({
      traceId: "trace-lineage",
      title: "Root",
      model: { providerID: "test", modelID: "root-model" },
    });

    const child = Session.createChild({
      traceId: "trace-lineage",
      parentSessionId: root.id,
      title: "Child",
      model: { providerID: "test", modelID: "child-model" },
    });

    const grandchild = Session.createChild({
      traceId: "trace-lineage",
      parentSessionId: child.id,
      title: "Grandchild",
      model: { providerID: "test", modelID: "grandchild-model" },
    });

    expect(root.spawnDepth).toBe(0);
    expect(child.spawnDepth).toBe(1);
    expect(grandchild.spawnDepth).toBe(2);
  });

  test("workerMeta round-trips through storage", () => {
    const parent = Session.create({
      traceId: "trace-lineage",
      title: "Parent",
      model: { providerID: "test", modelID: "parent-model" },
    });

    const child = Session.createChild({
      traceId: "trace-lineage",
      parentSessionId: parent.id,
      title: "Child",
      model: { providerID: "test", modelID: "child-model" },
      workerMeta: { lane: "worker-1", retries: 0 },
    });

    expect(Session.getWorkerMeta(child.id)).toEqual({ lane: "worker-1", retries: 0 });

    Session.updateWorkerMeta(child.id, { lane: "worker-2", retries: 1, state: "busy" });

    expect(Session.getWorkerMeta(child.id)).toEqual({
      lane: "worker-2",
      retries: 1,
      state: "busy",
    });
    expect(Session.get(child.id)?.workerMeta).toEqual({
      lane: "worker-2",
      retries: 1,
      state: "busy",
    });
  });

  test("createChild rejects missing parents without creating a child", () => {
    expect(() =>
      Session.createChild({
        traceId: "trace-lineage",
        parentSessionId: "missing-parent",
        title: "Orphan",
        model: { providerID: "test", modelID: "orphan-model" },
      }),
    ).toThrow("Parent session not found: missing-parent");

    expect(Session.list()).toEqual([]);
    expect(Session.listChildren("missing-parent")).toEqual([]);
  });

  test("updateWorkerMeta on a missing session is a no-op", () => {
    expect(() => Session.updateWorkerMeta("missing-session", { lane: "worker-1" })).not.toThrow();
    expect(Session.getWorkerMeta("missing-session")).toBeUndefined();
    expect(Session.list()).toEqual([]);
  });
});
