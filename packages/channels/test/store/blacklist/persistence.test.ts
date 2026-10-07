import { describe, expect, test } from "bun:test";
import { createBlacklistStore } from "../../../src/index.js";
import { testNow, useSqliteChannelStore } from "../helpers/sqlite";

describe("BlacklistStore SQLite persistence", () => {
  const stores = useSqliteChannelStore("blacklist");
  const blacklist = () => createBlacklistStore(stores.store);

  test("round-trips raw blacklist facts across storage reconfiguration", () => {
    const stored = blacklist().put({
      id: "bl-actor",
      kind: "actor",
      value: "act_bad",
      reason: "abuse",
      createdBy: "act_owner",
      createdAt: 100,
      updatedAt: 200,
    });

    stores.reopen();

    expect(blacklist().get(stored.id)).toEqual(stored);
    expect(blacklist().list()).toEqual([stored]);
  });

  test("removes exactly one stored fact", () => {
    blacklist().put({
      id: "bl-actor",
      kind: "actor",
      value: "act_bad",
      createdBy: "act_owner",
    });

    expect(blacklist().remove("bl-actor")).toBe(true);
    expect(blacklist().get("bl-actor")).toBeUndefined();
    expect(blacklist().remove("bl-actor")).toBe(false);
  });

  test("raw reads fail closed when the blacklist sub-adapter is absent", () => {
    expect(() => createBlacklistStore({ now: testNow }).list()).toThrow("does not implement blacklist");
  });
});
