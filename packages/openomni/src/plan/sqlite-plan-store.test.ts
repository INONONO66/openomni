import { Database } from "bun:sqlite";
import { describe, it, expect, beforeEach } from "bun:test";
import { SqlitePlanStore } from "./sqlite-plan-store.js";
import { Hashline } from "./hashline.js";

describe("SqlitePlanStore", () => {
  let store: SqlitePlanStore;

  beforeEach(() => {
    store = new SqlitePlanStore(new Database(":memory:"));
  });

  describe("write / read", () => {
    it("returns a PlanDocument with the written content", () => {
      store.write("plan-1", "hello world");
      const doc = store.read("plan-1");
      expect(doc).toBeDefined();
      expect(doc?.planId).toBe("plan-1");
      expect(doc?.content).toBe("hello world");
      expect(doc?.version).toBe(1);
      expect(typeof doc?.createdAt).toBe("number");
      expect(typeof doc?.updatedAt).toBe("number");
    });

    it("increments version on subsequent writes", () => {
      store.write("plan-1", "first");
      store.write("plan-1", "second");
      const doc = store.read("plan-1");
      expect(doc?.version).toBe(2);
      expect(doc?.content).toBe("second");
    });

    it("returns undefined for an unknown plan", () => {
      expect(store.read("no-such-plan")).toBeUndefined();
    });

    it("stores multiple plans independently", () => {
      store.write("plan-a", "alpha");
      store.write("plan-b", "beta");
      expect(store.read("plan-a")?.content).toBe("alpha");
      expect(store.read("plan-b")?.content).toBe("beta");
    });
  });

  describe("edit", () => {
    it("applies edits and returns updated content", () => {
      store.write("plan-1", "line one\nline two");
      const hash = Hashline.computeHash(1, "line one");

      const result = store.edit("plan-1", [
        { op: "replace", pos: `1#${hash}`, lines: ["line ONE"] },
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("line ONE\nline two");
      }
    });

    it("persists edits so subsequent reads see the new content", () => {
      store.write("plan-1", "line one\nline two");
      const hash = Hashline.computeHash(1, "line one");

      store.edit("plan-1", [{ op: "replace", pos: `1#${hash}`, lines: ["line ONE"] }]);

      expect(store.read("plan-1")?.content).toBe("line ONE\nline two");
    });

    it("increments version after edit", () => {
      store.write("plan-1", "a\nb");
      const hash = Hashline.computeHash(1, "a");
      store.edit("plan-1", [{ op: "replace", pos: `1#${hash}`, lines: ["A"] }]);
      expect(store.read("plan-1")?.version).toBe(2);
    });

    it("returns error for unknown plan", () => {
      const hash = Hashline.computeHash(1, "x");
      const result = store.edit("missing", [{ op: "replace", pos: `1#${hash}`, lines: ["y"] }]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain("Plan not found");
      }
    });

    it("returns error for stale ref", () => {
      store.write("plan-1", "original content");
      const staleHash = Hashline.computeHash(1, "different content");
      const result = store.edit("plan-1", [
        { op: "replace", pos: `1#${staleHash}`, lines: ["new"] },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain("stale ref");
      }
    });
  });

  describe("delete", () => {
    it("returns true and removes the plan", () => {
      store.write("plan-1", "content");
      expect(store.delete("plan-1")).toBe(true);
      expect(store.read("plan-1")).toBeUndefined();
    });

    it("returns false for a non-existent plan", () => {
      expect(store.delete("non-existent")).toBe(false);
    });

    it("only removes the targeted plan", () => {
      store.write("plan-a", "alpha");
      store.write("plan-b", "beta");
      store.delete("plan-a");
      expect(store.read("plan-a")).toBeUndefined();
      expect(store.read("plan-b")?.content).toBe("beta");
    });
  });
});
