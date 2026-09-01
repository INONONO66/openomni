import { describe, expect, test } from "bun:test";
import { canonicalKey, isPlainValue, PlainValueSchema, WorkItem } from "../src/index.js";

describe("plain JSON owner", () => {
  test("the typed key profile retains its established bytes", () => {
    expect(canonicalKey({ z: false, a: [2, "y", null] })).toBe(
      '{"a":[number:2,string:"y",null],"z":boolean:false}',
    );
  });

  test("one grammar rejects non-JSON values for live boundaries and typed keys", () => {
    expect(isPlainValue({ gap: undefined })).toBe(false);
    expect(PlainValueSchema.safeParse({ gap: undefined }).success).toBe(false);
    expect(() => canonicalKey({ gap: undefined } as never)).toThrow(
      "canonical key accepts plain JSON values only",
    );
  });

  test("canonical digest bytes remain pinned independently of object key order", () => {
    expect(WorkItem.canonicalDigest({ z: false, a: [2, "y"] })).toBe(
      "sha256:e53828d05df6b85481c1747214a1f672d2873303857ac4f335de3affe9ed8b50",
    );
  });
});
