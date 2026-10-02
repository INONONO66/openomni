import { describe, test, expect } from "bun:test";
import { Ingress } from "../src/ingress/index.js";
import { expectParseFailure } from "./helpers/schema.js";

function directEvent() {
  return {
    id: "event-1",
    traceId: "trace-test",
    surface: "cli",
    mode: "direct",
    payload: { query: "What is 2+2?" },
  };
}

describe("Ingress meta contracts", () => {
  test("parses actor and target metadata", () => {
    const meta = Ingress.MetaSchema.parse({
      actor: {
        role: "resident",
        trusted: true,
      },
      target: {
        kind: "worker",
        sessionId: "sess-1",
      },
      traceId: "trace-1",
    });

    expect(meta.actor?.role).toBe("resident");
    expect(meta.actor?.trusted).toBe(true);
    expect(meta.target?.kind).toBe("worker");
    expect(meta.target?.sessionId).toBe("sess-1");
  });

  test("parses worker target without identity as new worker request", () => {
    const meta = Ingress.MetaSchema.parse({
      target: {
        kind: "worker",
      },
    });

    expect(meta.target).toEqual({ kind: "worker" });
  });
});

describe("DirectEvent", () => {
  test("should parse valid direct event", () => {
    const event = Ingress.DirectEventSchema.parse(directEvent());
    expect(event.mode).toBe("direct");
    expect(event.id).toBe("event-1");
  });
});

describe("DirectEvent validation", () => {
  test("should parse direct event", () => {
    const event = Ingress.DirectEventSchema.parse(directEvent());
    expect(event.mode).toBe("direct");
  });

  test("should reject invalid mode value", () => {
    expectParseFailure(() =>
      Ingress.DirectEventSchema.parse({
        id: "event-1",
        surface: "cli",
        mode: "auto",
        payload: { goal: "Build API" },
      }),
    );
  });

  test("parses ADR-008 target aliases and actor metadata", () => {
    const resident = Ingress.DirectEventSchema.parse({
      id: "event-resident-1",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      target: "resident",
      payload: "hello",
      meta: { actor: { role: "user", id: "u1" } },
    });
    expect(resident.target).toEqual({ kind: "resident" });
    expect(resident.meta?.actor?.role).toBe("user");

    const worker = Ingress.DirectEventSchema.parse({
      id: "event-worker-1",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      target: "worker:worker-7",
      payload: "continue",
      meta: { actor: { role: "resident" } },
    });
    expect(worker.target).toEqual({ kind: "worker", workerId: "worker-7" });
  });

  test("parses worker target without workerId or sessionId", () => {
    const event = Ingress.DirectEventSchema.parse({
      id: "event-worker-new",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      target: { type: "worker" },
      payload: "start",
    });

    expect(event.target).toEqual({ kind: "worker" });
  });

  test("should reject missing id", () => {
    expectParseFailure(() =>
      Ingress.DirectEventSchema.parse({
        surface: "cli",
        mode: "direct",
        payload: { goal: "Build API" },
      }),
    );
  });
});
