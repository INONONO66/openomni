import { describe, expect, test } from "bun:test";
import { BlacklistStore, Storage } from "../../src/index.js";
import { useSqliteStorage } from "../helpers/storage";

describe("BlacklistStore SQLite persistence", () => {
  const fixture = useSqliteStorage("blacklist");

  test("round-trips raw blacklist facts across storage reconfiguration", () => {
    const stored = BlacklistStore.put({
      id: "bl-actor",
      kind: "actor",
      value: "act_bad",
      reason: "abuse",
      createdBy: "act_owner",
      createdAt: 100,
      updatedAt: 200,
    });

    fixture.reopen();

    expect(BlacklistStore.get(stored.id)).toEqual(stored);
    expect(BlacklistStore.list()).toEqual([stored]);
  });

  test("removes exactly one stored fact", () => {
    BlacklistStore.put({
      id: "bl-actor",
      kind: "actor",
      value: "act_bad",
      createdBy: "act_owner",
    });

    expect(BlacklistStore.remove("bl-actor")).toBe(true);
    expect(BlacklistStore.get("bl-actor")).toBeUndefined();
    expect(BlacklistStore.remove("bl-actor")).toBe(false);
  });

  test("raw reads fail closed when the blacklist sub-adapter is absent", () => {
    const bare = Storage.get();
    Storage.configure({
      transaction: bare.transaction.bind(bare),
      close: () => bare.close?.(),
    });

    expect(() => BlacklistStore.list()).toThrow("does not implement blacklist");
  });
});
