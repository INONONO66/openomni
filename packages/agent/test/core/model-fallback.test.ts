import { beforeAll, describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Message, Model } from "@openomni/protocol";
import { createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { allow } from "../helpers/policy-decision";
import { Bus } from "@openomni/telemetry";

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

function snapshot(id: string, text: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "test",
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "test",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}-t`, sessionID: "test", messageID: id, type: "text", text },
      {
        id: `${id}-s`,
        sessionID: "test",
        messageID: id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}

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
    sink.onMessage(snapshot(`msg-${calls}`, "recovered"));
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
