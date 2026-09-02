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

  test("a Trigger Fire carries typed activation and meta identity, not untyped fields", () => {
    const result = Ingress.InternalEventSchema.parse({
      id: "fire-9",
      traceId: "trace-fire",
      surface: "internal",
      mode: "internal",
      agentName: "resident",
      target: { kind: "resident", sessionId: "s-owner" },
      payload: "trigger fired",
      meta: {
        actor: { role: "system", id: "system:trigger" },
        kind: "trigger.fire",
        triggerId: "trigger-9",
        fireId: "fire-9",
      },
      activation: {
        trigger: {
          kind: "internal",
          id: "trigger-9",
          fireId: "fire-9",
          firedAt: 1_001,
          attempt: 2,
        },
      },
    });

    expect(result.meta?.triggerId).toBe("trigger-9");
    expect(result.meta?.fireId).toBe("fire-9");
    expect(result.activation?.trigger?.fireId).toBe("fire-9");
    expect(result.activation?.trigger?.attempt).toBe(2);
  });

  test("empty typed Trigger identity strings are rejected", () => {
    const base = {
      id: "fire-10",
      traceId: "trace-fire",
      surface: "internal",
      mode: "internal",
      agentName: "resident",
      payload: "x",
    };
    expectParseFailure(() =>
      Ingress.InternalEventSchema.parse({
        ...base,
        meta: { kind: "trigger.fire", triggerId: "", fireId: "fire-10" },
      }),
    );
    expectParseFailure(() =>
      Ingress.InternalEventSchema.parse({
        ...base,
        activation: { trigger: { kind: "internal", id: "t", fireId: "" } },
      }),
    );
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
