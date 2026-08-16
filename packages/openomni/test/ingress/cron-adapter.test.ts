import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEvent, type Ingress } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";

let CronAdapter: typeof import("../../src/ingress/cron-adapter").CronAdapter;
let createIngressEngine: typeof import("../../src/ingress/engine")["createIngressEngine"];

beforeEach(async () => {
  ({ CronAdapter } = await import("../../src/ingress/cron-adapter"));
  ({ createIngressEngine } = await import("../../src/ingress/engine"));
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterAll(() => {
  mock.restore();
});

describe("CronAdapter.fire", () => {
  it("calls ingestInternal with correct event shape", async () => {
    let capturedEvent: Ingress.InternalEvent | undefined;
    const engine = {
      ingestInternal: async (event: Ingress.InternalEvent): Promise<Ingress.IngressResult> => {
        capturedEvent = event;
        return {
          mode: "internal",
          target: { kind: "resident" },
          sessionId: "test",
          result: { output: "ok", finishReason: "stop" },
        };
      },
    };

    await CronAdapter.fire(
      { id: "job-1", agentName: "dev", payload: "hello" },
      engine,
      "trace-test",
    );

    // D11 keystone pin (#654 review): the fired event carries the tick's
    // trace — the run and CronJobFired share one identity.
    expect(capturedEvent?.traceId).toBe("trace-test");
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
    const engine = createIngressEngine({
      agentResolver: {
        resolve: async () => ({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } }),
      },
      coordinator: {
        async dispatch(_sessionId, request) {
          return {
            runId: request.runId,
            sessionId: request.sessionId,
            status: "succeeded" as const,
            output: "ok",
            finishReason: "stop" as const,
          };
        },
      },
    });

    try {
      await CronAdapter.fire(
        {
          id: "job-received",
          agentName: "dev",
          payload: "hello",
          target: { kind: "worker" },
        },
        engine,
        "trace-test",
      );
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
