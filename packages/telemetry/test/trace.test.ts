import { describe, expect, test } from "bun:test";
import {
  fromTraceparent,
  isSpanId,
  isTraceId,
  newSpanId,
  newTraceId,
  requireTraceScope,
  rootScope,
  spanStatus,
  spanStatusMessage,
  toTraceparent,
} from "@openomni/telemetry";

/** The example from W3C Trace Context §3.2. */
const SPEC_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPEC_SPAN_ID = "b7ad6b7169203331";
const SPEC_HEADER = `00-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01`;

describe("trace ids", () => {
  test("minted ids satisfy their own predicates", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isTraceId(newTraceId())).toBe(true);
      expect(isSpanId(newSpanId())).toBe(true);
    }
  });

  test("the reserved all-zero ids are invalid", () => {
    expect(isTraceId("0".repeat(32))).toBe(false);
    expect(isSpanId("0".repeat(16))).toBe(false);
  });

  test("uppercase hex and wrong lengths are rejected", () => {
    expect(isTraceId(SPEC_TRACE_ID.toUpperCase())).toBe(false);
    expect(isTraceId(SPEC_TRACE_ID.slice(0, 31))).toBe(false);
    expect(isSpanId(SPEC_SPAN_ID.toUpperCase())).toBe(false);
    expect(isTraceId(undefined)).toBe(false);
  });
});

describe("traceparent", () => {
  test("round-trips the spec's example", () => {
    expect(toTraceparent({ traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID })).toBe(SPEC_HEADER);
    expect(fromTraceparent(SPEC_HEADER)).toEqual({
      traceId: SPEC_TRACE_ID,
      parentSpanId: SPEC_SPAN_ID,
    });
  });

  /**
   * §3.2.2.1: a higher version parses as version 00 when the first 55
   * characters match, and fields after the flags are ignored. Rejecting them
   * would make a peer's version bump silently start a new trace — an invisible
   * break in exactly the case this header exists for.
   */
  test("accepts a future version and ignores trailing fields", () => {
    expect(fromTraceparent(`01-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01`)).toEqual({
      traceId: SPEC_TRACE_ID,
      parentSpanId: SPEC_SPAN_ID,
    });
    expect(fromTraceparent(`01-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01-vendor=x`)).toEqual({
      traceId: SPEC_TRACE_ID,
      parentSpanId: SPEC_SPAN_ID,
    });
  });

  test("rejects the forbidden version, malformed shapes, and invalid ids", () => {
    expect(fromTraceparent(`ff-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01`)).toBeUndefined();
    expect(fromTraceparent(`00-${SPEC_TRACE_ID.toUpperCase()}-${SPEC_SPAN_ID}-01`)).toBeUndefined();
    expect(fromTraceparent(`00-${"0".repeat(32)}-${SPEC_SPAN_ID}-01`)).toBeUndefined();
    expect(fromTraceparent(`00-${SPEC_TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
    expect(fromTraceparent(`00-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}`)).toBeUndefined();
    expect(fromTraceparent(undefined)).toBeUndefined();
    expect(fromTraceparent("")).toBeUndefined();
  });

  /** Version 00's grammar is closed at 55 characters. */
  test("rejects trailing fields on version 00", () => {
    expect(fromTraceparent(`${SPEC_HEADER}-extra`)).toBeUndefined();
  });

  test("tolerates surrounding whitespace", () => {
    expect(fromTraceparent(`  ${SPEC_HEADER}  `)?.traceId).toBe(SPEC_TRACE_ID);
  });
});

describe("scope construction", () => {
  test("rootScope mints a trace and a span", () => {
    const scope = rootScope({ sessionId: "s", runId: "r" });
    expect(isTraceId(scope.traceId)).toBe(true);
    expect(isSpanId(scope.spanId)).toBe(true);
    expect(scope.parentSpanId).toBeUndefined();
  });

  test("requireTraceScope reports every problem at once", () => {
    try {
      requireTraceScope({ traceId: "nope", spanId: "nope" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as { problems: string[] }).problems).toEqual([
        "traceId must be 32 lowercase hex characters",
        "spanId must be 16 lowercase hex characters",
        "sessionId is required",
        "runId is required",
      ]);
    }
  });
});

describe("span status", () => {
  test("only a completed span is ok", () => {
    expect(spanStatus({ kind: "completed" })).toBe("ok");
    expect(spanStatus({ kind: "budget_exhausted", limit: "turns" })).toBe("error");
    expect(spanStatus({ kind: "failed", error: new Error("x") })).toBe("error");
    expect(
      spanStatus({ kind: "guard_denied", point: "run.turn.pre", policyId: "p", reason: "r" }),
    ).toBe("error");
  });

  test("the message names why, and a completed span has none", () => {
    expect(spanStatusMessage({ kind: "completed" })).toBeUndefined();
    expect(
      spanStatusMessage({
        kind: "guard_denied",
        point: "run.turn.pre",
        policyId: "p",
        reason: "r",
      }),
    ).toBe("run.turn.pre: r");
    expect(spanStatusMessage({ kind: "budget_exhausted", limit: "turns" })).toBe(
      "budget exhausted: turns",
    );
    expect(spanStatusMessage({ kind: "failed", error: new Error("boom") })).toBe("boom");
  });
});
