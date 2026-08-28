import { describe, expect, test } from "bun:test";
import { WorkItem } from "../src/index.js";

/**
 * Era pin: pre-hardening fingerprint schemas admitted own keys named
 * __proto__/constructor/prototype into immutable persisted facts (e.g.
 * work_item.attempt_allocated). The persisted-fact JSON profile must keep
 * accepting those bytes forever; only the live policy boundary refuses them
 * (pinned in test/policy/effect-json-plain.test.ts).
 */
describe("work-item fingerprint era compatibility", () => {
  const legacyInputs = () =>
    JSON.parse(
      `{"workInput":"do it","handlerKind":"agent","handlerCodeRef":"ref:abc","model":{"provider":"openai","id":"gpt","parameters":{"nested":{"__proto__":{"enabled":true}},"constructor":"c","prototype":1}},"upstreamFingerprints":{"absent":true,"reason":"none consumed"},"dependencyLock":{"absent":true,"reason":"unlocked"}}`,
    ) as unknown;

  test("accepts persisted fingerprints carrying __proto__/constructor/prototype own keys", () => {
    const inputs = legacyInputs();
    const digest = WorkItem.canonicalDigest(inputs);
    const parsed = WorkItem.ContentFingerprint.parse({ inputs, digest });
    const parameters = parsed.inputs.model.parameters as Record<string, unknown>;
    expect(Object.keys(parameters)).toEqual(["nested", "constructor", "prototype"]);
    // Nested legacy keys survive as own data properties (no rebuild, no
    // prototype mutation), so the digest re-render stays byte-stable.
    expect(Object.keys(parameters.nested as object)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(parameters.nested)).toBe(Object.prototype);
    expect(WorkItem.canonicalDigest(parsed.inputs)).toBe(digest);
  });

  test("still refuses non-JSON structure the old schema also could not persist", () => {
    const inputs = legacyInputs() as { model: { parameters: Record<string, unknown> } };
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "sneaky", {
      enumerable: true,
      get: () => "boo",
    });
    inputs.model.parameters = accessor;
    const digest = `sha256:${"0".repeat(64)}`;
    expect(WorkItem.ContentFingerprint.safeParse({ inputs, digest }).success).toBe(false);
  });
});
