import { describe, expect, it } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { resolveTarget, targetKey } from "../../src/ingress";

describe("ingress target helpers", () => {
  it("defaults events without explicit target to resident", () => {
    const event = Ingress.InboundEventSchema.parse({
      id: "event-resident-default",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      payload: "hello",
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });

    expect(resolveTarget(event)).toEqual({ kind: "resident" });
  });

  it("resolves explicit target before metadata target", () => {
    const event = Ingress.InboundEventSchema.parse({
      id: "event-worker-explicit",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      target: "worker:worker-7",
      meta: { target: { kind: "resident" } },
      payload: "continue",
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });

    expect(resolveTarget(event)).toEqual({ kind: "worker", workerId: "worker-7" });
  });

  it("builds stable target keys", () => {
    expect(targetKey({ kind: "resident" })).toBe("resident");
    expect(targetKey({ kind: "resident", sessionId: "sess-1" })).toBe("resident:sess-1");
    expect(targetKey({ kind: "worker" })).toBe("worker");
    expect(targetKey({ kind: "worker", workerId: "worker-7" })).toBe("worker:worker-7");
    expect(targetKey({ kind: "worker", sessionId: "sess-2" })).toBe("worker-session:sess-2");
  });
});
