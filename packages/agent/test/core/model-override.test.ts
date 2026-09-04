import { beforeAll, describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { assistantSnapshot } from "../helpers/assistant-snapshot";
import { allow, inject } from "../helpers/policy-decision";
import { Bus } from "../../src/index";

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

const primary = { provider: "anthropic", id: "primary-model" };
const override = { provider: "openai", id: "override-model" };

function overrideOnce() {
  let fired = false;
  return {
    kind: "point" as const,
    name: "test-model-override",
    pointIds: ["connection.llm.pre" as const],
    effectCapabilities: { "connection.llm.pre": ["model.override" as const] },
    priority: 100,
    fn: () => {
      if (fired) return allow("test.model-override");
      fired = true;
      return allow("test.model-override", undefined, [
        { type: "model.override", provider: override.provider, id: override.id },
      ]);
    },
  };
}

function overrideAfterFirstConnection() {
  let connections = 0;
  return {
    kind: "point" as const,
    name: "test-delayed-model-override",
    pointIds: ["connection.llm.pre" as const],
    effectCapabilities: { "connection.llm.pre": ["model.override" as const] },
    priority: 100,
    fn: () => {
      connections += 1;
      if (connections === 1) return allow("test.delayed-model-override");
      return allow("test.delayed-model-override", undefined, [
        { type: "model.override", provider: override.provider, id: override.id },
      ]);
    },
  };
}

function continueOnce() {
  let injected = false;
  return {
    kind: "point" as const,
    name: "test-continue-once",
    pointIds: ["run.turn.post" as const],
    effectCapabilities: { "run.turn.post": ["prompt.inject_message" as const] },
    priority: 100,
    fn: () => {
      if (injected) return allow("test.continue-once");
      injected = true;
      return inject("keep going");
    },
  };
}

function harness(windows: Record<string, number | undefined>) {
  const calls: Array<{ modelId: string | undefined; yieldAt: number | undefined }> = [];
  const resolved: Model.Ref[] = [];
  const run: MockLlmFn = async (input, sink: Sink) => {
    calls.push({ modelId: input.model?.id, yieldAt: input.yieldAtInputTokens });
    sink.onMessage(assistantSnapshot(`msg-${calls.length}`, `turn ${calls.length}`));
    return createStopOutcome();
  };
  const llm = {
    run,
    resolveProviderModel: async (model: Model.Ref) => {
      resolved.push(model);
      const context = windows[model.id];
      return {
        id: model.id,
        name: model.id,
        providerID: model.provider,
        ...(context === undefined ? {} : { limit: { context, output: 1000 } }),
      };
    },
  };
  return { calls, resolved, llm };
}

describe("model.override at connection.llm.pre (#753)", () => {
  it("captures the configured runner before model-request policy effects", async () => {
    const calls: string[] = [];
    const captured: MockLlmFn = async (_input, sink) => {
      calls.push("captured");
      sink.onMessage(assistantSnapshot("captured", "captured runner"));
      return createStopOutcome();
    };
    const replacement: MockLlmFn = async (_input, sink) => {
      calls.push("replacement");
      sink.onMessage(assistantSnapshot("replacement", "replacement runner"));
      return createStopOutcome();
    };
    let activeRun = captured;
    const llm = {
      get run(): MockLlmFn {
        return activeRun;
      },
      resolveProviderModel: async (model: Model.Ref) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
    };

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      llm,
      middleware: [
        {
          kind: "point",
          name: "test-runner-capture-timing",
          pointIds: ["connection.llm.pre" as const],
          effectCapabilities: { "connection.llm.pre": ["audit.annotate" as const] },
          priority: 100,
          fn: () => {
            activeRun = replacement;
            return allow("test.runner-capture-timing");
          },
        },
      ],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(calls).toEqual(["captured"]);
  });

  it("reroutes exactly one connection and reverts on the next — connection scope", async () => {
    const { calls, resolved, llm } = harness({});
    const observedPostIds: unknown[] = [];

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      llm,
      middleware: [
        overrideOnce(),
        continueOnce(),
        {
          kind: "point",
          name: "test-post-capture",
          pointIds: ["connection.llm.post"],
          effectCapabilities: { "connection.llm.post": ["audit.annotate"] },
          priority: 90,
          fn: (ctx) => {
            observedPostIds.push(ctx.modelId);
            return allow("test.post-capture");
          },
        },
      ],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    // Call 1 ran the override; call 2 (continuation turn) reverted to the
    // per-attempt selection — the effect is connection-scoped.
    expect(calls.map((c) => c.modelId)).toEqual([override.id, primary.id]);
    // connection.llm.post reports the model ACTUALLY called, both times.
    expect(observedPostIds).toEqual([override.id, primary.id]);
    // The override resolved through the same seam the attempt resolution uses.
    expect(resolved).toEqual([primary, override]);
  });

  it("skips re-resolution when the override names the model already selected", async () => {
    const { calls, resolved, llm } = harness({});
    let fired = false;

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      llm,
      middleware: [
        {
          kind: "point",
          name: "test-noop-override",
          pointIds: ["connection.llm.pre"],
          effectCapabilities: { "connection.llm.pre": ["model.override"] },
          priority: 100,
          fn: () => {
            if (fired) return allow("test.noop-override");
            fired = true;
            return allow("test.noop-override", undefined, [
              { type: "model.override", provider: primary.provider, id: primary.id },
            ]);
          },
        },
      ],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(calls.map((c) => c.modelId)).toEqual([primary.id]);
    expect(resolved).toEqual([primary]);
  });

  it("recomputes the window-yield arm point from the override model's window", async () => {
    const { calls, llm } = harness({ [primary.id]: 1000, [override.id]: 500 });

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      llm,
      middleware: [overrideOnce(), continueOnce()],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    // Call 1: the override's 500-token window arms at 400 (0.8), not the
    // primary's 800. Call 2 reverts to the primary's plan.
    expect(calls).toEqual([
      { modelId: override.id, yieldAt: 225 },
      { modelId: primary.id, yieldAt: 450 },
    ]);
  });

  it("keeps a reclaimed-nothing window yield disarmed across a model override", async () => {
    const yieldArms: Array<number | undefined> = [];
    let calls = 0;
    const llm = {
      run: (async (input, sink: Sink) => {
        calls += 1;
        yieldArms.push(input.yieldAtInputTokens);
        sink.onMessage(
          assistantSnapshot(
            `msg-${calls}`,
            `turn ${calls}`,
            calls === 1 ? "tool-calls" : "stop",
          ),
        );
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
      llm,
      middleware: [overrideAfterFirstConnection()],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    // The first call yields at the primary window and reclaims nothing, so
    // the remaining headroom is real. A connection-scoped override on the
    // continuation must not arm another yield against that same history.
    expect(yieldArms).toEqual([450, undefined]);
  });

  it("fails honestly on an override to a nonexistent model — bounded retries, zero llm calls", async () => {
    const resolved: string[] = [];
    let llmCalls = 0;
    const llm = {
      run: (async () => {
        llmCalls += 1;
        return createStopOutcome();
      }) as MockLlmFn,
      resolveProviderModel: async (model: Model.Ref) => {
        resolved.push(model.id);
        if (model.id === override.id) {
          throw new Error(`Model not found: ${model.id} for provider ${model.provider}`);
        }
        return { id: model.id, name: model.id, providerID: model.provider };
      },
    };
    const persistentOverride = {
      kind: "point" as const,
      name: "test-ghost-override",
      pointIds: ["connection.llm.pre" as const],
      effectCapabilities: { "connection.llm.pre": ["model.override" as const] },
      priority: 100,
      fn: () =>
        allow("test.ghost-override", undefined, [
          { type: "model.override", provider: override.provider, id: override.id },
        ]),
    };
    const zeroBackoff = {
      kind: "point" as const,
      name: "test-zero-backoff",
      pointIds: ["run.error.error" as const],
      effectCapabilities: { "run.error.error": ["run.retry_after" as const] },
      priority: 100,
      fn: () => allow("test.zero-backoff", undefined, [{ type: "run.retry_after", delayMs: 0 }]),
    };

    await expect(
      ChatAgent.create({
        events: Bus,
        model: primary,
        llm,
        middleware: [persistentOverride, zeroBackoff],
      }).run(runInput([{ role: "user", content: "go" }])),
    ).rejects.toThrow("Model not found");

    // Three attempts (default ceiling), each: attempt model resolves, the
    // ghost override throws — the model is never called, and with no
    // fallbacks configured the attempt selection stays the primary (a
    // policy-caused fault must not silently walk a chain).
    expect(llmCalls).toBe(0);
    expect(resolved).toEqual([
      primary.id,
      override.id,
      primary.id,
      override.id,
      primary.id,
      override.id,
    ]);
  });
  it("drops the arm point entirely when the override model's window is unknown", async () => {
    const { calls, llm } = harness({ [primary.id]: 1000 });

    const result = await ChatAgent.create({
      events: Bus,
      model: primary,
      llm,
      middleware: [overrideOnce()],
    }).run(runInput([{ role: "user", content: "go" }]));

    expect(result.finishReason).toBe("stop");
    expect(calls).toEqual([{ modelId: override.id, yieldAt: undefined }]);
  });
});
