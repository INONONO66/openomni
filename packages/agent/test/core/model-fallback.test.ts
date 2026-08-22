import { beforeAll, describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { assistantSnapshot } from "../helpers/assistant-snapshot";
import { allow } from "../helpers/policy-decision";
import { Bus } from "@openomni/telemetry";

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

/** Zero-backoff retry so the tests pin selection, not the schedule. */
const zeroBackoff = {
  kind: "point" as const,
  name: "test-zero-backoff",
  pointIds: ["run.error.error" as const],
  effectCapabilities: { "run.error.error": ["run.retry_after" as const] },
  priority: 100,
  fn: () => allow("test.zero-backoff", undefined, [{ type: "run.retry_after", delayMs: 0 }]),
};

function fallbackHarness(errorMessage: string) {
  const resolved: Model.Ref[] = [];
  let calls = 0;
  const run: MockLlmFn = async (_input, sink: Sink) => {
    calls += 1;
    if (calls === 1) {
      return { type: "error", error: { message: errorMessage, name: "Error" } };
    }
    sink.onMessage(assistantSnapshot(`msg-${calls}`, "recovered"));
    return createStopOutcome();
  };
  const llm = {
    run,
    resolveProviderModel: async (model: Model.Ref) => {
      resolved.push(model);
      return { id: model.id, name: model.id, providerID: model.provider };
    },
  };
  return { resolved, llm };
}

describe("model fallback via placement (#752)", () => {
  it("advances to the fallback on a transient failure — decided facts drive the chain", async () => {
    const { resolved, llm } = fallbackHarness("transient blip");

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      modelFallbacks: [fallback],
      llm,
      middleware: [zeroBackoff],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(resolved).toEqual([primary, fallback]);
  });

  it("stays on the primary for a tool_error retry — the tool failed, not the model", async () => {
    const { resolved, llm } = fallbackHarness("tool exploded");

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      modelFallbacks: [fallback],
      llm,
      middleware: [zeroBackoff],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(resolved).toEqual([primary, primary]);
  });

  it("retries a validation_error onto the fallback — model-specific refusal reaches a different model (#752 F1)", async () => {
    const { resolved, llm } = fallbackHarness("validation failed: unusable shape");

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      modelFallbacks: [fallback],
      llm,
      middleware: [zeroBackoff],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(resolved).toEqual([primary, fallback]);
  });

  it("keeps validation_error terminal without a fallback chain — blind same-model retry stays refused (#752 F1)", async () => {
    const { resolved, llm } = fallbackHarness("validation failed: unusable shape");

    await expect(
      ChatAgent.create({
        events: Bus,
        model: primary,
        llm,
        middleware: [zeroBackoff],
      }).run(runInput([{ role: "user", content: "go" }])),
    ).rejects.toThrow("validation failed");
    expect(resolved).toEqual([primary]);
  });

  it("reports the ACTUAL model to connection.llm.pre after a fallback switch (#752 F4)", async () => {
    const { llm } = fallbackHarness("transient blip");
    const observedModelIds: unknown[] = [];

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      modelFallbacks: [fallback],
      llm,
      middleware: [
        zeroBackoff,
        {
          kind: "point",
          name: "test-model-capture",
          pointIds: ["connection.llm.pre"],
          effectCapabilities: { "connection.llm.pre": ["audit.annotate"] },
          priority: 100,
          fn: (ctx) => {
            observedModelIds.push(ctx.modelId);
            return allow("test.model-capture");
          },
        },
      ],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(observedModelIds).toEqual([primary.id, fallback.id]);
  });

  it("re-arms the window yield when a fallback switch changes the model (#752 F3)", async () => {
    const yieldArms: Array<number | undefined> = [];
    let calls = 0;
    const llm = {
      run: (async (input, sink: Sink) => {
        calls += 1;
        yieldArms.push(input.yieldAtInputTokens);
        if (calls === 1) {
          // Primary turn 1: end mid tool-loop so the WINDOW yield fires; no
          // compaction seam is registered, so the seam reclaims nothing and
          // the loop DISARMS the yield.
          sink.onMessage(assistantSnapshot("msg-w1", "working", "tool-calls"));
          return createStopOutcome();
        }
        if (calls === 2) {
          // Primary turn 2 (disarmed): fail transient — the retry switches
          // to the fallback model.
          return { type: "error", error: { message: "transient blip", name: "Error" } };
        }
        sink.onMessage(assistantSnapshot(`msg-w${calls}`, "recovered"));
        return createStopOutcome();
      }) as MockLlmFn,
      resolveProviderModel: async (model: Model.Ref) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
        limit: { context: model.id === primary.id ? 1000 : 500, output: 1000 },
      }),
    };

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      modelFallbacks: [fallback],
      llm,
      middleware: [zeroBackoff],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    // Turn 1: armed from the primary's window (1000 × 0.8). Turn 2: disarmed
    // (the seam reclaimed nothing — primary's headroom was real). Turn 3: the
    // model CHANGED, so the guard reset and the fallback's own window arms
    // (500 × 0.8) — carrying the disarm over would fire the smaller window
    // blind.
    expect(yieldArms).toEqual([800, undefined, 400]);
  });

  it("uses the primary on every attempt when no fallbacks are configured", async () => {
    const { resolved, llm } = fallbackHarness("transient blip");

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      llm,
      middleware: [zeroBackoff],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(resolved).toEqual([primary, primary]);
  });
});
