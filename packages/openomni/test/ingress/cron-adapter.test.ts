import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Ingress } from "@openomni/protocol";

let CronAdapter: typeof import("../../src/ingress/cron-adapter").CronAdapter;
let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;

beforeEach(async () => {
  ({ CronAdapter } = await import("../../src/ingress/cron-adapter"));
  ({ IngressEngine } = await import("../../src/ingress/engine"));
  IngressEngine.reset();
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
});
