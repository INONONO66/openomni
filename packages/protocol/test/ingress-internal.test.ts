import { describe, expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";
import { expectParseFailure } from "./helpers/schema.js";

describe("InternalEventSchema", () => {
  test("parses valid internal event", () => {
    const result = Ingress.InternalEventSchema.parse({
      id: "test-1",
      traceId: "trace-test",
      surface: "cron",
      mode: "internal",
      agentName: "dev",
      payload: "hello",
    });

    expect(result.mode).toBe("internal");
    expect(result.agentName).toBe("dev");
  });

  test("rejects missing agentName", () => {
    expectParseFailure(() =>
      Ingress.InternalEventSchema.parse({
        id: "test-2",
        surface: "cron",
        mode: "internal",
        payload: "hello",
      }),
    );
  });

  test("external inbound schema rejects internal events", () => {
    expectParseFailure(() =>
      Ingress.DirectEventSchema.parse({
        id: "t3",
        surface: "cron",
        mode: "internal",
        agentName: "dev",
        payload: "test",
      }),
    );
  });
});
