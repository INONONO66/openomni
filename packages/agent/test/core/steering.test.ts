import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { assistantSnapshot } from "../helpers/assistant-snapshot";
import { allow, inject } from "../helpers/policy-decision";
import { Bus } from "@openomni/telemetry";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const mockLlm = createMockLlmConfig({
  getModels: mock(async () => mockProviderData),
  fromModelsDevModel: mock(() => mockProviderModel),
  run: (input, sink: Sink) => mockRunFn(input, sink),
});

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

const baseConfig = {
  events: Bus,
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  llm: mockLlm,
};

function textsOf(messages: readonly unknown[]): string[] {
  return (messages as Message.WithParts[]).flatMap((message) =>
    message.parts
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text),
  );
}

describe("mid-turn steering (#751)", () => {
  it("yields at the step boundary and the drained injection reaches the next model call", async () => {
    // The host side of the seam, simulated: a pending mid-turn message that
    // the run.turn.post drain converts into a continuation (the same shape
    // the production injection queue uses) and then clears.
    let pending = true;
    const llmCalls: Array<{ sawYield: boolean | undefined; texts: string[] }> = [];

    mockRunFn = async (input, sink) => {
      const call = llmCalls.length;
      if (call === 0) {
        // Mid tool-loop: the SDK evaluates the stop conditions at the step
        // boundary — the mock mimics exactly that one evaluation.
        const sawYield = input.shouldYield?.();
        llmCalls.push({ sawYield, texts: textsOf(input.messages ?? []) });
        sink.onMessage(assistantSnapshot("msg-steer-1", "working on it", "tool-calls"));
        return createStopOutcome();
      }
      llmCalls.push({ sawYield: input.shouldYield?.(), texts: textsOf(input.messages ?? []) });
      sink.onMessage(assistantSnapshot("msg-steer-2", "done", "stop"));
      return createStopOutcome();
    };

    const result = await ChatAgent.create({
      ...baseConfig,
      steeringPending: () => pending,
      middleware: [
        {
          kind: "point",
          name: "test-steering-drain",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["prompt.inject_message"] },
          priority: 100,
          fn: () => {
            if (!pending) return allow("test.steering-drain");
            pending = false;
            return inject("urgent user note");
          },
        },
      ],
    }).run(runInput([{ role: "user", content: "start" }]));

    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("done");
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]?.sawYield).toBe(true);
    // The steered-in message is model input on the very next call.
    expect(llmCalls[1]?.texts).toContain("urgent user note");
    // Cleared pending: the second turn's check must not re-fire.
    expect(llmCalls[1]?.sawYield).toBe(false);
  });

  it("continues past a steering yield even when nothing drains — never max-steps", async () => {
    let pending = true;
    let calls = 0;

    mockRunFn = async (input, sink) => {
      calls += 1;
      if (calls === 1) {
        input.shouldYield?.();
        // The "pending" signal clears without producing a continuation (the
        // message drained elsewhere) — the race the steer arm exists for.
        pending = false;
        sink.onMessage(assistantSnapshot("msg-race-1", "mid work", "tool-calls"));
        return createStopOutcome();
      }
      sink.onMessage(assistantSnapshot("msg-race-2", "finished", "stop"));
      return createStopOutcome();
    };

    const result = await ChatAgent.create({
      ...baseConfig,
      steeringPending: () => pending,
    }).run(runInput([{ role: "user", content: "start" }]));

    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("finished");
    expect(calls).toBe(2);
  });

  it("passes no shouldYield to the llm when steering is not configured", async () => {
    let sawShouldYield: unknown = "unset";
    mockRunFn = async (input, sink) => {
      sawShouldYield = input.shouldYield;
      sink.onMessage(assistantSnapshot("msg-none", "plain", "stop"));
      return createStopOutcome();
    };

    const result = await ChatAgent.create(baseConfig).run(
      runInput([{ role: "user", content: "start" }]),
    );

    expect(result.finishReason).toBe("stop");
    expect(sawShouldYield).toBeUndefined();
  });
});

describe("attempt identity in lifecycle policy context (#694 material)", () => {
  it("run.turn.pre observes the same turnIndex under an advancing attempt on retry", async () => {
    const observed: Array<{ attempt: unknown; turnIndex: unknown }> = [];
    let calls = 0;

    mockRunFn = async (_input, sink) => {
      calls += 1;
      if (calls === 1) {
        // A retryable transient failure: the runner re-enters the SAME turn.
        return { type: "error", error: { message: "transient blip", name: "Error" } };
      }
      sink.onMessage(assistantSnapshot("msg-retry", "recovered", "stop"));
      return createStopOutcome();
    };

    const result = await ChatAgent.create({
      ...baseConfig,
      middleware: [
        {
          kind: "point",
          name: "test-attempt-capture",
          pointIds: ["run.turn.pre"],
          // Observe-only: the engine refuses empty capability maps, so the
          // narrowest declarable effect stands in.
          effectCapabilities: { "run.turn.pre": ["audit.annotate"] },
          priority: 100,
          fn: (ctx) => {
            observed.push({ attempt: ctx.attempt, turnIndex: ctx.turnIndex });
            return allow("test.attempt-capture");
          },
        },
        {
          // Zero backoff so the retry is immediate — the test pins identity,
          // not the schedule.
          kind: "point",
          name: "test-zero-backoff",
          pointIds: ["run.error.error"],
          effectCapabilities: { "run.error.error": ["run.retry_after"] },
          priority: 100,
          fn: () =>
            allow("test.zero-backoff", undefined, [{ type: "run.retry_after", delayMs: 0 }]),
        },
      ],
    }).run(runInput([{ role: "user", content: "start" }]));

    expect(result.finishReason).toBe("stop");
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({ attempt: 1, turnIndex: 0 });
    // Retry re-entry of the SAME turn: turnIndex holds, attempt advances —
    // the pair a stall guard needs to stop misreading retries as progress.
    expect(observed[1]).toEqual({ attempt: 2, turnIndex: 0 });
  });
});
