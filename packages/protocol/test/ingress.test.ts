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
        kind: "resident",
        sessionId: "sess-1",
      },
      traceId: "trace-1",
    });

    expect(meta.actor?.role).toBe("resident");
    expect(meta.actor?.trusted).toBe(true);
    expect(meta.target?.kind).toBe("resident");
    expect(meta.target?.sessionId).toBe("sess-1");
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

    const pinned = Ingress.DirectEventSchema.parse({
      id: "event-pinned-1",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      target: { kind: "resident", sessionId: "sess-7" },
      payload: "continue",
      meta: { actor: { role: "resident" } },
    });
    expect(pinned.target).toEqual({ kind: "resident", sessionId: "sess-7" });
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
