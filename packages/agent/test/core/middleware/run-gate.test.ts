import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import type {
  AgentEvent,
  AgentResult,
  ChatAgentConfig,
  ChatAgentInput,
} from "../../../src/core/types";
import type { MiddlewareContext } from "../../../src/core/middleware";
import {
  createStopOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../../helpers/mock-llm";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const callOrder: string[] = [];
const capturedRunMessages: unknown[][] = [];

const mockLlm = createMockLlmConfig({
  getModels: mock(async () => mockProviderData),
  fromModelsDevModel: mock(() => mockProviderModel),
  run: (input, sink: Sink) => {
    callOrder.push("llm_turn");
    capturedRunMessages.push(Array.from(input.messages ?? []));
    return mockRunFn(input, sink);
  },
});

let streamAgent: typeof import("../../../src/core/execution/stream-engine").streamAgent;

beforeAll(async () => {
  ({ streamAgent } = await import("../../../src/core/execution/stream-engine"));
});

const defaultConfig: ChatAgentConfig = {
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  llm: mockLlm,
};

const defaultInput: ChatAgentInput = {
  messages: [{ role: "user", content: "hello" }],
};

async function collectEvents(
  config: ChatAgentConfig,
  input: ChatAgentInput = defaultInput,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of streamAgent(input, config)) {
    events.push(event);
  }
  return events;
}

function getResult(events: AgentEvent[]): AgentResult | undefined {
  const ev = events.find((e) => e.type === "complete");
  return ev ? (ev as Extract<AgentEvent, { type: "complete" }>).result : undefined;
}

beforeEach(() => {
  callOrder.length = 0;
  capturedRunMessages.length = 0;
  mockRunFn = async () => createStopOutcome();
});

describe("pre_run middleware dispatch", () => {
  it("fires before the first LLM turn", async () => {
    const preRunFn = mock((_ctx: MiddlewareContext) => {
      callOrder.push("pre_run");
      return { action: "continue" as const };
    });

    await collectEvents({
      ...defaultConfig,
      middleware: [{ name: "test:pre_run", timing: "pre_run", priority: 100, fn: preRunFn }],
    });

    expect(preRunFn).toHaveBeenCalledTimes(1);
    const preRunIdx = callOrder.indexOf("pre_run");
    const llmIdx = callOrder.indexOf("llm_turn");
    expect(preRunIdx).toBeGreaterThanOrEqual(0);
    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(preRunIdx).toBeLessThan(llmIdx);
  });

  it("abort → guardAborted: true and no LLM turn", async () => {
    const events = await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:pre_run_abort",
          timing: "pre_run",
          priority: 100,
          fn: () => ({ action: "abort" as const, reason: "blocked" }),
        },
      ],
    });

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result?.guardAborted).toBe(true);
    expect(result?.steps).toHaveLength(0);
    expect(callOrder).not.toContain("llm_turn");
  });

  it("inject → injected message appears in context passed to first LLM turn", async () => {
    const injectedContent = "injected-pre-run-context";

    await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:pre_run_inject",
          timing: "pre_run",
          priority: 100,
          fn: () => ({
            action: "inject" as const,
            message: injectedContent,
            reason: "inject-pre-run-context",
            policyId: "test.pre-run-inject",
          }),
        },
      ],
    });

    expect(capturedRunMessages.length).toBeGreaterThan(0);

    type MsgShape = { parts: Array<{ type: string; text?: string }> };
    const firstTurnMsgs = capturedRunMessages[0] as MsgShape[];
    const hasInjected = firstTurnMsgs.some((m) =>
      m.parts.some((p) => p.type === "text" && p.text === injectedContent),
    );
    expect(hasInjected).toBe(true);
  });
});

describe("post_run middleware dispatch", () => {
  it("fires after normal completion with result context", async () => {
    const postRunFn = mock((_ctx: MiddlewareContext) => ({ action: "continue" as const }));

    await collectEvents({
      ...defaultConfig,
      middleware: [{ name: "test:post_run", timing: "post_run", priority: 100, fn: postRunFn }],
    });

    expect(postRunFn).toHaveBeenCalledTimes(1);
    const ctx = postRunFn.mock.calls[0][0] as MiddlewareContext;
    expect(ctx.timing).toBe("post_run");
    expect(ctx.isCompletion).toBe(true);
    expect(Array.isArray(ctx.steps)).toBe(true);
  });

  it("fires after budget exceeded (max-steps completion)", async () => {
    const postRunFn = mock((_ctx: MiddlewareContext) => ({ action: "continue" as const }));

    const events = await collectEvents({
      ...defaultConfig,
      budget: { maxTurns: 0 },
      middleware: [
        { name: "test:post_run_budget", timing: "post_run", priority: 100, fn: postRunFn },
      ],
    });

    const result = getResult(events);
    expect(result?.finishReason).toBe("max-steps");
    expect(postRunFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire after pre_turn abort", async () => {
    const postRunFn = mock((_ctx: MiddlewareContext) => ({ action: "continue" as const }));

    await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:pre_turn_abort",
          timing: "pre_turn",
          priority: 100,
          fn: () => ({ action: "abort" as const, reason: "blocked" }),
        },
        { name: "test:post_run_watcher", timing: "post_run", priority: 100, fn: postRunFn },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(0);
  });

  it("does NOT fire after post_turn abort", async () => {
    const postRunFn = mock((_ctx: MiddlewareContext) => ({ action: "continue" as const }));

    await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:post_turn_abort",
          timing: "post_turn",
          priority: 100,
          fn: () => ({ action: "abort" as const, reason: "blocked" }),
        },
        { name: "test:post_run_watcher", timing: "post_run", priority: 100, fn: postRunFn },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(0);
  });

  it("transform verdict → AgentResult.text is replaced", async () => {
    const transformedText = "post-run-transformed-result";

    const events = await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:post_run_transform",
          timing: "post_run",
          priority: 100,
          fn: () => ({
            action: "transform" as const,
            input: { text: transformedText },
            reason: "replace-result-text",
            policyId: "test.post-run-transform",
          }),
        },
      ],
    });

    const result = getResult(events);
    expect(result?.text).toBe(transformedText);
  });
});
