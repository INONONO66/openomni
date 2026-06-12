import { describe, expect, test } from "bun:test";
import { Actor } from "../src/actor/index.js";

describe("Blacklist protocol contracts", () => {
  test("parses active actor, endpoint, channel, and pattern entries", () => {
    for (const kind of ["actor", "endpoint", "channel", "pattern"] as const) {
      const entry = Actor.BlacklistEntry.parse({
        id: `bl-${kind}`,
        kind,
        value: `${kind}:value`,
        reason: "abuse",
        createdBy: "act_owner",
      });

      expect(entry.kind).toBe(kind);
      expect(entry.createdBy).toBe("act_owner");
    }
  });

  test("rejects entries without an audit creator", () => {
    let failed = false;
    try {
      Actor.BlacklistEntry.parse({
        id: "bl-missing-creator",
        kind: "actor",
        value: "act_bad",
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
  });
});
