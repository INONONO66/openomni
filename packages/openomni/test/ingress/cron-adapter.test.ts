import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEvent, type Ingress } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";

let CronAdapter: typeof import("../../src/ingress/cron-adapter").CronAdapter;
let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;

beforeEach(async () => {
  ({ CronAdapter } = await import("../../src/ingress/cron-adapter"));
  ({ IngressEngine } = await import("../../src/ingress/engine"));
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterAll(() => {
  mock.restore();
});

describe("CronAdapter.fire", () => {
  it("calls ingestInternal with correct event shape", async () => {
    let capturedEvent: Ingress.InternalEvent | undefined;
    IngressEngine.setAgentResolver({
      resolve: async () => ({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } }),
    });

    const originalIngestInternal = IngressEngine.ingestInternal;
    IngressEngine.ingestInternal = async (event) => {
      capturedEvent = event;
      return {
        mode: "internal",
        target: { kind: "resident" },
        sessionId: "test",
        result: { output: "ok", finishReason: "stop" },
      };
    };

    try {
      await CronAdapter.fire({ id: "job-1", agentName: "dev", payload: "hello" });
    } finally {
      IngressEngine.ingestInternal = originalIngestInternal;
    }

    expect(capturedEvent?.surface).toBe("cron");
    expect(capturedEvent?.mode).toBe("internal");
    expect(capturedEvent?.agentName).toBe("dev");
    expect(capturedEvent?.runtime?.trigger?.kind).toBe("cron");
    expect(capturedEvent?.runtime?.trigger?.id).toBe("job-1");
  });

  it("emits IngressEvent.Received when fired through ingestInternal", async () => {
    const received: Array<{ surface: string; mode: string; target?: string }> = [];
    const unsubscribe = Bus.subscribe(IngressEvent.Received, (event) => {
      received.push(event);
    });
    IngressEngine.setAgentResolver({
      resolve: async () => ({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } }),
    });
    IngressEngine.setCoordinator({
      async dispatch(_sessionId, request) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded" as const,
          output: "ok",
          finishReason: "stop" as const,
        };
      },
    });

    try {
      await CronAdapter.fire({
        id: "job-received",
        agentName: "dev",
        payload: "hello",
        target: { kind: "worker" },
      });
    } finally {
      unsubscribe();
    }

    expect(received.at(-1)).toMatchObject({
      surface: "cron",
      mode: "internal",
      target: "worker",
    });
  });
});
