import { describe, expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

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

  test("trigger metadata parses correctly", () => {
    const result = Ingress.InternalEventSchema.parse({
      id: "test-3",
      traceId: "trace-test",
      surface: "cron",
      mode: "internal",
      agentName: "dev",
      payload: "hello",
      activation: {
        trigger: { kind: "cron", id: "job-1", scheduledAt: 1000, firedAt: 1001 },
      },
    });

    expect(result.activation?.trigger?.kind).toBe("cron");
    expect(result.activation?.trigger?.id).toBe("job-1");
  });
});

function expectParseFailure(parse: () => unknown): void {
  let failed = false;
  try {
    parse();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}
