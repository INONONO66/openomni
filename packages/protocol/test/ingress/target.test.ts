import { describe, expect, it } from "bun:test";
import { Ingress } from "../../src/ingress/index.js";
import { resolveTarget, targetKey } from "../../src/ingress/index.js";

// #1315: the retired subordinate-target prefix, kept as a plain literal so
// the refusal stays tested; the vocabulary-retirement grep excludes this file.
const RETIRED_TARGET_PREFIX = "worker";

describe("ingress target helpers", () => {
  it("defaults events without explicit target to resident", () => {
    const event = Ingress.DirectEventSchema.parse({
      id: "event-resident-default",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      payload: "hello",
    });

    expect(resolveTarget(event)).toEqual({ kind: "resident" });
  });

  it("refuses the retired string-form subordinate target as a typed parse failure", () => {
    const parsed = Ingress.TargetSchema.safeParse(`${RETIRED_TARGET_PREFIX}:abc`);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected a typed parse failure");
    expect(parsed.error.issues.length).toBeGreaterThan(0);
    // Nothing defaults to resident on the failure path.
    expect(() => resolveTarget({ target: `${RETIRED_TARGET_PREFIX}:abc` as never })).toThrow();
  });

  it("refuses the retired object-form subordinate target", () => {
    expect(
      Ingress.TargetSchema.safeParse({ kind: RETIRED_TARGET_PREFIX, sessionId: "sess-2" }).success,
    ).toBe(false);
    expect(Ingress.TargetSchema.safeParse({ type: RETIRED_TARGET_PREFIX }).success).toBe(false);
  });

  it("resolves metadata targets when no explicit target is present", () => {
    expect(
      resolveTarget({ meta: { target: { kind: "resident", sessionId: "sess-meta" } } }),
    ).toEqual({ kind: "resident", sessionId: "sess-meta" });
  });

  it("resolves explicit target before metadata target", () => {
    const event = Ingress.DirectEventSchema.parse({
      id: "event-explicit",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      target: { kind: "resident", sessionId: "sess-7" },
      meta: { target: { kind: "resident" } },
      payload: "continue",
    });

    expect(resolveTarget(event)).toEqual({ kind: "resident", sessionId: "sess-7" });
  });

  it("builds stable target keys", () => {
    expect(targetKey({ kind: "resident" })).toBe("resident");
    expect(targetKey({ kind: "resident", sessionId: "sess-1" })).toBe("resident:sess-1");
  });
});
