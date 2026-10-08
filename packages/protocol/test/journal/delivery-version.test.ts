import { describe, expect, test } from "bun:test";
import { canonicalDigest, SessionTurn, type PlainValue } from "../../src/index.js";
import {
  foldDeliveryPayload,
  V1_DELIVERY_ID_FIELD,
  V1_DELIVERY_IDS_FIELD,
  V1_DELIVERY_KIND_FIELD,
} from "../../src/journal/core/prompt.js";

const origin = { encodingVersion: 1, value: { kind: "human" } } as const;

/** A recorded version-1 prompt row payload, exactly as old files persist it. */
function v1PromptIntent(): Record<string, PlainValue> {
  return {
    [V1_DELIVERY_ID_FIELD]: "input-1",
    body: "hello",
    origin: origin.value,
    createdAt: 100,
    ordinal: 1,
  };
}

describe("versioned delivery readers (#1315)", () => {
  test("a version-1 prompt row with the retired id field folds to deliveryId with the same value", () => {
    const recorded = v1PromptIntent();
    const bytes = JSON.stringify(recorded);
    const digest = canonicalDigest(recorded);

    const folded = foldDeliveryPayload(recorded);
    expect(folded).toEqual({
      deliveryId: "input-1",
      body: "hello",
      origin: origin.value,
      createdAt: 100,
      ordinal: 1,
    });

    // The fold never rewrites stored bytes: the recorded payload is
    // untouched, so the chain digest over it is unchanged.
    expect(JSON.stringify(recorded)).toBe(bytes);
    expect(canonicalDigest(recorded)).toBe(digest);
  });

  test("a version-1 turn intent folds deliveryIds with the same ids and order", () => {
    const recorded: Record<string, PlainValue> = {
      phase: "intent",
      resultId: "result-1",
      [V1_DELIVERY_IDS_FIELD]: ["input-2", "input-1", "input-3"],
      resumeCount: 0,
      boundaryActionId: null,
      toolsGeneration: 1,
      toolsHash: "tools-hash",
      systemHash: "system-hash",
      policyGeneration: 1,
    };
    const digest = canonicalDigest(recorded);

    const folded = foldDeliveryPayload(recorded) as Record<string, PlainValue>;
    expect(folded.deliveryIds).toEqual(["input-2", "input-1", "input-3"]);
    const parsed = SessionTurn.DecodeIntent.parse(folded);
    expect(parsed.deliveryIds).toEqual(["input-2", "input-1", "input-3"]);
    expect(canonicalDigest(recorded)).toBe(digest);
  });

  test("a version-1 delivery-phase effect folds and parses under the version-2 name", () => {
    const recorded: Record<string, PlainValue> = {
      phase: "delivery",
      turnId: "turn-1",
      [V1_DELIVERY_ID_FIELD]: "input-1",
      kind: "prompt",
      content: "hello",
      origin: { encodingVersion: 1, value: origin.value },
      boundary: "before_llm",
    };
    const parsed = SessionTurn.Delivery.parse(foldDeliveryPayload(recorded));
    expect(parsed.deliveryId).toBe("input-1");
  });

  test("a version-1 input-row effect folds its kind marker", () => {
    const recorded: Record<string, PlainValue> = {
      [V1_DELIVERY_KIND_FIELD]: "prompt",
      content: "hello",
    };
    const folded = foldDeliveryPayload(recorded) as Record<string, PlainValue>;
    expect(folded.deliveryKind).toBe("prompt");
    expect(V1_DELIVERY_KIND_FIELD in folded).toBe(false);
  });

  test("a version-2 payload keeps its names and identity through the fold", () => {
    const current: Record<string, PlainValue> = { deliveryId: "input-9", body: "hi" };
    expect(foldDeliveryPayload(current)).toBe(current);
    expect(foldDeliveryPayload(null)).toBeNull();
    expect(foldDeliveryPayload([1, 2])).toEqual([1, 2]);
  });
});
