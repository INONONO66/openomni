import { expect, test } from "bun:test";
import { DateTime, PrimaryKey, Schema } from "effect";
import { DeliverAt } from "effect/cluster";
import { AlarmRpc } from "../../src/core/messages";

// #1253: alarm occurrences are durable not-before clocks — the sharding
// scheduler reads DeliverAt off the decoded payload, so the instant must
// round-trip exactly, and the occurrence id is the cluster primary key the
// redelivery dedupe rides on.
test("an alarm occurrence delivers exactly at its durable not-before instant", () => {
  const occurrence = Schema.decodeUnknownSync(AlarmRpc.payloadSchema)({
    occurrenceId: "req-1:deadline",
    purpose: "deadline",
    body: JSON.stringify({ requestId: "req-1" }),
    fireAt: 5_000,
  });
  expect(DateTime.toEpochMillis(occurrence[DeliverAt.symbol]())).toBe(5_000);
  expect(occurrence[PrimaryKey.symbol]()).toBe("req-1:deadline");
});
