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

  test("discriminated union routes by mode", () => {
    const internal = Ingress.InboundEventSchema.parse({
      id: "t1",
      traceId: "trace-test",
      surface: "cron",
      mode: "internal",
      agentName: "dev",
      payload: "test",
    });
    expect(internal.mode).toBe("internal");

    const direct = Ingress.InboundEventSchema.parse({
      id: "t2",
      traceId: "trace-test",
      surface: "discord",
      mode: "direct",
      agentName: "dev",
      payload: "test",
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });
    expect(direct.mode).toBe("direct");
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
      runtime: {
        trigger: { kind: "cron", id: "job-1", scheduledAt: 1000, firedAt: 1001 },
      },
    });

    expect(result.runtime?.trigger?.kind).toBe("cron");
    expect(result.runtime?.trigger?.id).toBe("job-1");
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
