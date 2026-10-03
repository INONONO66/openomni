import { expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import { DeliverAt } from "effect/cluster";
import { DeadlineRpc, RetryScheduledRpc, WatchTimeoutRpc } from "../../src/core/messages";

// C2 wakes are durable not-before clocks: the sharding scheduler reads
// DeliverAt off the decoded payload, so the instant must round-trip exactly.
test("timer wake payloads deliver exactly at their durable not-before instant", () => {
  const retry = Schema.decodeUnknownSync(RetryScheduledRpc.payloadSchema)({
    alarmId: "alarm",
    attempt: 2,
    notBefore: 1_234,
  });
  expect(DateTime.toEpochMillis(retry[DeliverAt.symbol]())).toBe(1_234);

  const deadline = Schema.decodeUnknownSync(DeadlineRpc.payloadSchema)({
    requestId: "request",
    deadlineAt: 5_000,
  });
  expect(DateTime.toEpochMillis(deadline[DeliverAt.symbol]())).toBe(5_000);

  const timeout = Schema.decodeUnknownSync(WatchTimeoutRpc.payloadSchema)({
    watchId: "watch",
    epoch: 3,
    fireAt: 9_999,
  });
  expect(DateTime.toEpochMillis(timeout[DeliverAt.symbol]())).toBe(9_999);
});
