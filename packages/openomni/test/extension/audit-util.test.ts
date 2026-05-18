import { describe, expect, test } from "bun:test";
import { actorLabel } from "../../src/extension/audit-util";

describe("extension audit utilities", () => {
  test("actorLabel serializes circular actor metadata deterministically", () => {
    const actor: Record<string, unknown> = { name: "cyclic" };
    actor.self = actor;

    expect(actorLabel(actor)).toBe('{"name":"cyclic","self":"[Circular]"}');
  });
});
