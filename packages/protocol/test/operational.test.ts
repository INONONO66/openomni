import { describe, expect, test } from "bun:test";
import { Operational } from "../src/event/operational.js";

describe("Operational.envelope", () => {
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
