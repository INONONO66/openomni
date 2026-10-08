import { describe, expect, test } from "bun:test";
import {
  canonicalDigest,
  canonicalJson,
  canonicalKey,
  PlainObjectSchema,
  PlainValueSchema,
} from "../src/index.js";
import { CanonicalJsonError, JsonShapedValueSchema } from "../src/json.js";
import { PolicyPermission } from "../src/policy/permission.js";

describe("plain JSON owner", () => {
  test("the typed key profile retains its established bytes", () => {
    expect(canonicalKey({ z: false, a: [2, "y", null] })).toBe(
      '{"a":[number:2,string:"y",null],"z":boolean:false}',
    );
  });

  test("canonical JSON bytes sort keys and round-trip through JSON.parse", () => {
    const value = { z: false, a: [2, "y", null], n: { b: 1, a: "x" } };
    const bytes = canonicalJson(value);
    expect(bytes).toBe('{"a":[2,"y",null],"n":{"a":"x","b":1},"z":false}');
    expect(JSON.parse(bytes)).toEqual(value);
    expect(() => canonicalJson({ gap: undefined } as never)).toThrow(CanonicalJsonError);
  });

  test("one grammar rejects non-JSON values for live boundaries and typed keys", () => {
    expect(PlainValueSchema.safeParse({ gap: undefined }).success).toBe(false);
    expect(() => canonicalKey({ gap: undefined } as never)).toThrow(CanonicalJsonError);
  });

  test("the object profile admits one JSON record and refuses every other JSON value", () => {
    const record = { tool: "read", args: { path: "/tmp/x", lines: [1, 2] } };
    expect(PlainObjectSchema.parse(record)).toEqual(record);
    for (const value of ["text", 1, true, null, [record]]) {
      const parsed = PlainObjectSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("Expected a plain JSON object");
    }
    expect(PlainObjectSchema.safeParse({ gap: undefined }).success).toBe(false);
  });

  test("rejects values whose property descriptors cannot be read", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("unreadable keys");
        },
      },
    );

    expect(PlainValueSchema.safeParse(hostile).success).toBe(false);
  });

  test("canonical digest rejects values outside the JSON grammar", () => {
    expect(() => canonicalDigest(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalDigest(new Date(0))).toThrow(CanonicalJsonError);
    expect(() => canonicalDigest({ missing: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalDigest({ gap: Number.NaN })).toThrow(CanonicalJsonError);
  });

  test("canonical digest bytes remain pinned independently of object key order", () => {
    expect(canonicalDigest({ z: false, a: [2, "y"] })).toBe(
      "sha256:e53828d05df6b85481c1747214a1f672d2873303857ac4f335de3affe9ed8b50",
    );
  });
});

describe("JSON-shaped wire boundary", () => {
  test("rejects a function, a non-finite number, a Date, and undefined inside an array", () => {
    for (const value of [
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      [undefined],
      { nested: { deep: [1, Number.NaN] } },
    ]) {
      const parsed = JsonShapedValueSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("Expected a JSON-shaped value");
    }
  });

  test("rejects a value whose property descriptors cannot be read", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("unreadable keys");
        },
      },
    );
    expect(JsonShapedValueSchema.safeParse(hostile).success).toBe(false);
  });

  test("accepts a nested record and keeps explicit undefined record slots expressible", () => {
    const nested = { a: { b: [1, "two", null, { c: false }] }, d: "edge" };
    expect(JsonShapedValueSchema.parse(nested)).toEqual(nested);
    expect(JsonShapedValueSchema.safeParse({ omitted: undefined, kept: 1 }).success).toBe(true);
  });

  test("the policy evaluation request carries only JSON-shaped record fields", () => {
    const base = { action: "tool.call", resource: "read" };
    expect(
      PolicyPermission.EvaluationRequest.safeParse({
        ...base,
        input: { path: "/tmp/x" },
        actor: { id: "a-1" },
        resourceMeta: { labels: ["secret"] },
        metadata: { nested: { depth: 2 } },
      }).success,
    ).toBe(true);
    for (const field of ["input", "actor", "resourceMeta", "metadata"]) {
      expect(
        PolicyPermission.EvaluationRequest.safeParse({ ...base, [field]: { bad: () => 1 } }).success,
      ).toBe(false);
    }
  });
});
