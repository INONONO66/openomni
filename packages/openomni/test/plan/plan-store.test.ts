import { describe, expect, it } from "bun:test";
import { Hashline } from "../../src/plan/hashline.js";
import { InMemoryPlanStore } from "../../src/plan/plan-store";

const refFor = (lines: string[], lineNumber: number) =>
  `${lineNumber}#${Hashline.computeHash(lineNumber, lines[lineNumber - 1] ?? "")}`;

describe("InMemoryPlanStore", () => {
  it("write → read lifecycle: content + version=1 + planId", () => {
    const store = new InMemoryPlanStore();
    store.write("p1", "hello world");

    const doc = store.read("p1");
    expect(doc).toBeDefined();
    expect(doc!.planId).toBe("p1");
    expect(doc!.content).toBe("hello world");
    expect(doc!.version).toBe(1);
    expect(doc!.createdAt).toBeGreaterThan(0);
    expect(doc!.updatedAt).toBeGreaterThanOrEqual(doc!.createdAt);
  });

  it("read nonexistent → undefined", () => {
    const store = new InMemoryPlanStore();
    expect(store.read("nope")).toBeUndefined();
  });

  it("write overwrite → version increments", () => {
    const store = new InMemoryPlanStore();
    store.write("p1", "v1");

    const first = store.read("p1")!;
    expect(first.version).toBe(1);
    const originalCreatedAt = first.createdAt;

    store.write("p1", "v2");

    const second = store.read("p1")!;
    expect(second.version).toBe(2);
    expect(second.content).toBe("v2");
    expect(second.createdAt).toBe(originalCreatedAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt);
  });

  it("edit success → content changed + version incremented", () => {
    const store = new InMemoryPlanStore();
    const original = "line one\nline two\nline three";
    store.write("p1", original);

    const lines = original.split("\n");
    const ref = refFor(lines, 2);

    const result = store.edit("p1", [{ op: "replace", pos: ref, lines: ["line TWO"] }]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("line one\nline TWO\nline three");
    }

    const doc = store.read("p1")!;
    expect(doc.version).toBe(2);
    expect(doc.content).toBe("line one\nline TWO\nline three");
  });

  it("edit nonexistent plan → { ok: false, errors } containing 'not found'", () => {
    const store = new InMemoryPlanStore();
    const result = store.edit("ghost", [{ op: "replace", pos: "1#ZZ", lines: ["x"] }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
    }
  });

  it("edit stale hash → { ok: false, errors } with stale ref", () => {
    const store = new InMemoryPlanStore();
    store.write("p1", "line one\nline two");

    const result = store.edit("p1", [{ op: "replace", pos: "1#ZZ", lines: ["changed"] }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("stale ref"))).toBe(true);
    }
  });

  it("delete → true, then read → undefined", () => {
    const store = new InMemoryPlanStore();
    store.write("p1", "data");

    expect(store.delete("p1")).toBe(true);
    expect(store.read("p1")).toBeUndefined();
  });

  it("delete nonexistent → false", () => {
    const store = new InMemoryPlanStore();
    expect(store.delete("nope")).toBe(false);
  });
});
