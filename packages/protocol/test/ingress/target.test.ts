import { describe, expect, it } from "bun:test";
import { Ingress } from "../../src/ingress/index.js";
import { extractSurfaceKey, resolveTarget, targetKey } from "../../src/ingress/index.js";

describe("ingress target helpers", () => {
  it("defaults events without explicit target to resident", () => {
    const event = Ingress.DirectEventSchema.parse({
      id: "event-resident-default",
      traceId: "trace-test",
      surface: "cli",
      mode: "direct",
      payload: "hello",
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });

    expect(resolveTarget(event)).toEqual({ kind: "resident" });
  });

  it("resolves metadata targets when no explicit target is present", () => {
    expect(
      resolveTarget({ meta: { target: { kind: "worker", workerId: "worker-meta" } } }),
    ).toEqual({
      kind: "worker",
      workerId: "worker-meta",
    });
  });

  it("resolves explicit target before metadata target", () => {
    const event = Ingress.DirectEventSchema.parse({
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

  it("separates worker surface sessions while preserving resident keys", () => {
    expect(extractSurfaceKey({ surface: "cli", workspace: "ws", channel: "ch" })).toBe("cli:ws:ch");
    expect(
      extractSurfaceKey({
        surface: "cli",
        workspace: "ws",
        channel: "ch",
        target: { kind: "resident", sessionId: "resident-session" },
      }),
    ).toBe("cli:ws:ch");
    expect(
      extractSurfaceKey({
        surface: "cli",
        workspace: "ws",
        channel: "ch",
        meta: { target: { kind: "worker", workerId: "worker-7" } },
      }),
    ).toBe("cli:ws:ch:target:worker:worker-7");
  });
});
