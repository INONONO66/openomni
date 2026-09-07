import { expect, test } from "bun:test";
import type { PolicyRow } from "@openomni/protocol";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { createMemoryL0Adapter } from "./memory-l0-adapter";

const first: Omit<PolicyRow.Row, "generation"> = {
  name: "first",
  kind: "tool",
  phase: "pre",
  match: { encodingVersion: 1, value: {} },
  verdict: { encodingVersion: 1, value: { type: "allow" } },
  priority: 10,
};
const second = { ...first, name: "second" };

for (const backend of ["memory", "SQLite"] as const) {
  test(`${backend}: policy generations select, copy and append atomically`, () => {
    const sqlite = backend === "SQLite" ? new SqliteStorageAdapter(":memory:") : undefined;
    const storage = sqlite ?? createMemoryL0Adapter();
    const policies = storage.policies;
    try {
      expect(
        policies.appendGeneration((current) => {
          expect(current).toEqual([]);
          return undefined;
        }),
      ).toBe(0);
      expect(() => policies.appendGeneration(() => [])).toThrow(
        "policy generation must not be empty",
      );
      expect(policies.appendGeneration(() => [first])).toBe(1);
      const original = policies.rows();
      expect(() =>
        policies.appendGeneration((current) => {
          expect(current).toEqual([{ ...first, generation: 1 }]);
          return [...current, second, second];
        }),
      ).toThrow("could not append policy row: second");
      expect(policies.rows()).toEqual(original);
      expect(policies.rows(2)).toEqual([]);
      expect(() =>
        policies.appendGeneration((current) => [...current, { ...second, priority: 1.5 }]),
      ).toThrow();
      expect(policies.rows()).toEqual(original);
      expect(() =>
        policies.appendGeneration(() => {
          throw new Error("derivation refused");
        }),
      ).toThrow("derivation refused");
      expect(policies.rows()).toEqual(original);
      expect(policies.appendGeneration((current) => [...current, second])).toBe(2);
      const latest = [
        { ...first, generation: 2 },
        { ...second, generation: 2 },
      ];
      expect(policies.rows(2)).toEqual(latest);
      const complete = policies.rows();
      expect(
        policies.appendGeneration((current) => {
          expect(current).toEqual(latest);
          return undefined;
        }),
      ).toBe(2);
      expect(policies.rows()).toEqual(complete);
      expect(() =>
        storage.transaction(() => {
          expect(policies.appendGeneration((current) => current)).toBe(3);
          throw new Error("outer refusal");
        }),
      ).toThrow("outer refusal");
      expect(policies.rows()).toEqual(complete);
    } finally {
      sqlite?.close();
    }
  });
}
