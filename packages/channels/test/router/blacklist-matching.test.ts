import { beforeEach, describe, expect, test } from "bun:test";
import { BlacklistStore, Storage } from "@openomni/ledger";
import { matchBlacklist } from "../../src/router/blacklist";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

describe("blacklist perimeter matching", () => {
  test("matches active actor and endpoint facts", () => {
    BlacklistStore.put({
      id: "bl-actor",
      kind: "actor",
      value: "act_bad",
      createdBy: "act_owner",
    });
    BlacklistStore.put({
      id: "bl-endpoint",
      kind: "endpoint",
      value: "ep_old",
      expiresAt: 2,
      createdBy: "act_owner",
    });

    expect(matchBlacklist({ actorId: "act_bad" })?.id).toBe("bl-actor");
    expect(matchBlacklist({ endpointId: "ep_old" }, 1)?.id).toBe("bl-endpoint");
    expect(matchBlacklist({ endpointId: "ep_old" }, 2)).toBeUndefined();
  });

  test("matches wildcard pattern facts without crossing unmatched segments", () => {
    BlacklistStore.put({
      id: "bl-pattern",
      kind: "pattern",
      value: "discord:*:dev",
      createdBy: "act_owner",
    });

    expect(matchBlacklist({ candidates: ["discord:guild:dev"] })?.id).toBe("bl-pattern");
    expect(matchBlacklist({ candidates: ["discord:other:prod"] })).toBeUndefined();
  });

  test("matches channel facts against the canonical channel and candidates", () => {
    BlacklistStore.put({
      id: "bl-channel",
      kind: "channel",
      value: "dev",
      createdBy: "act_owner",
    });

    expect(matchBlacklist({ channel: "dev" })?.id).toBe("bl-channel");
    expect(matchBlacklist({ candidates: ["dev"] })?.id).toBe("bl-channel");
  });
});
