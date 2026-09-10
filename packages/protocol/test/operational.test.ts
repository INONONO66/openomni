import { describe, expect, test } from "bun:test";
import { Operational } from "../src/event/operational.js";

describe("Operational.envelope", () => {
  test("parses JSON context values with a typed result", () => {
    const event = Operational.Events.Info.schema.parse({
      traceId: "trace-1",
      time: 123,
      component: "test",
      msg: "context",
      context: { nullable: null, nested: [[], {}] },
    });
    expect(event.context).toEqual({ nullable: null, nested: [[], {}] });
  });

  test("uses the caller-supplied timestamp", () => {
    expect(
      Operational.envelope(
        {
          traceId: "trace-1",
          component: "test",
          msg: "deterministic event",
        },
        123,
      ),
    ).toEqual({
      traceId: "trace-1",
      component: "test",
      msg: "deterministic event",
      time: 123,
    });
  });
});
