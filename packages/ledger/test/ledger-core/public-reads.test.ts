import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReplyGrantStore, Storage } from "../../src/index";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

test("retained decision reads return the newest fact and type-ordered immutable evidence", () => {
  const ledger = Storage.get().ledger;
  if (ledger === undefined) throw new Error("missing decision ledger");
  expect(ledger.headFact("absent")).toBeUndefined();
  expect(ledger.factsByType("proof")).toEqual([]);
  for (const [streamId, type, revision] of [
    ["b", "proof", 0],
    ["a", "proof", 0],
    ["a", "other", 1],
    ["a", "proof", 2],
  ] as const) {
    expect(
      ledger.append({ streamId, type, data: { revision }, timeCreated: revision + 1 }, revision)
        .kind,
    ).toBe("appended");
  }
  expect(ledger.headFact("a")).toMatchObject({
    streamId: "a",
    seq: 3,
    type: "proof",
    data: { revision: 2 },
  });
  expect(ledger.factsByType("proof").map((fact) => [fact.streamId, fact.seq])).toEqual([
    ["a", 1],
    ["a", 3],
    ["b", 1],
  ]);
  expect(ledger.factsByType("other")).toHaveLength(1);
});

test("published reply-grant projection survives repeated claims and refuses absent capability", () => {
  const grant = {
    id: "reply",
    senderId: "resident",
    targetActorId: "peer",
    operations: ["fire_and_forget" as const],
    ruleId: "rule",
    expiresAt: 100,
    replyScope: { surfaceKey: "ws:peer" },
  };
  expect(ReplyGrantStore.listLive(1)).toEqual([]);
  expect(ReplyGrantStore.claim(grant, { at: 1, maxLiveInstances: 1 })).toBe("claimed");
  expect(ReplyGrantStore.claim(grant, { at: 1, maxLiveInstances: 1 })).toBe("existing");
  expect(ReplyGrantStore.listLive(1)).toEqual([grant]);
  expect(ReplyGrantStore.listLive(101)).toEqual([]);
  Storage.reset();
  Storage.configure({ transaction: (operation) => operation() });
  expect(() => ReplyGrantStore.listLive(1)).toThrow("reply grants");
});
