import { describe, expect, test } from "bun:test";
import { delegationTraceId } from "../src/delegation/trace";

const W3C_TRACE = /^[0-9a-f]{32}$/;

describe("delegationTraceId", () => {
  test("a UUID delegation id maps 1:1 onto its hyphen-stripped hex digits", () => {
    const delegationId = "c4a4e104-355e-47a8-9781-be3b6d604fa2";
    expect(delegationTraceId(delegationId)).toBe("c4a4e104355e47a89781be3b6d604fa2");
  });

  test("the nil UUID never becomes the invalid all-zero trace id", () => {
    const traceId = delegationTraceId("00000000-0000-0000-0000-000000000000");
    expect(traceId).toMatch(W3C_TRACE);
    expect(traceId).not.toBe("0".repeat(32));
  });

  test("non-UUID ids derive deterministic, distinct, valid trace ids", () => {
    const first = delegationTraceId("d-wake-failure");
    expect(first).toMatch(W3C_TRACE);
    expect(delegationTraceId("d-wake-failure")).toBe(first);
    expect(delegationTraceId("d-other")).not.toBe(first);
  });
});
