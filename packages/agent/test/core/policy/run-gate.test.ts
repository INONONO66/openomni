import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import type {
  AgentEvent,
  AgentResult,
  ChatAgentConfig,
  ChatAgentInput,
} from "../../../src/core/types";
import type { PolicyContext } from "../../../src/core/policy";
import {
  createStopOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../../helpers/mock-llm";
import { abortRun, allow, inject } from "../../helpers/policy-decision";

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

describe("run.start middleware dispatch", () => {
  it("fires before the first LLM turn", async () => {
    const preRunFn = mock((_ctx: PolicyContext) => {
      callOrder.push("run.start");
      return allow();
    });

    await collectEvents({
      ...defaultConfig,
      middleware: [{ name: "test:run.start", timing: "run.start", priority: 100, fn: preRunFn }],
    });

    expect(preRunFn).toHaveBeenCalledTimes(1);
    const preRunIdx = callOrder.indexOf("run.start");
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
          name: "test:run.start_abort",
          timing: "run.start",
          priority: 100,
          fn: () => abortRun("test.run-start-abort", "blocked"),
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
          name: "test:run.start_inject",
          timing: "run.start",
          priority: 100,
          fn: () => inject(injectedContent, "test.pre-run-inject", "inject-pre-run-context"),
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

describe("run.finish middleware dispatch", () => {
  it("fires after normal completion with result context", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    await collectEvents({
      ...defaultConfig,
      middleware: [{ name: "test:run.finish", timing: "run.finish", priority: 100, fn: postRunFn }],
    });

    expect(postRunFn).toHaveBeenCalledTimes(1);
    const ctx = postRunFn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("run.finish");
    expect(ctx.isCompletion).toBe(true);
    expect(Array.isArray(ctx.steps)).toBe(true);
  });

  it("fires after budget exceeded (max-steps completion)", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    const events = await collectEvents({
      ...defaultConfig,
      budget: { maxTurns: 0 },
      middleware: [
        { name: "test:run.finish_budget", timing: "run.finish", priority: 100, fn: postRunFn },
      ],
    });

    const result = getResult(events);
    expect(result?.finishReason).toBe("max-steps");
    expect(postRunFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire after turn.start abort", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:turn.start_abort",
          timing: "turn.start",
          priority: 100,
          fn: () => abortRun("test.turn-start-abort", "blocked"),
        },
        { name: "test:run.finish_watcher", timing: "run.finish", priority: 100, fn: postRunFn },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(0);
  });

  it("does NOT fire after turn.finish abort", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:turn.finish_abort",
          timing: "turn.finish",
          priority: 100,
          fn: () => abortRun("test.turn-finish-abort", "blocked"),
        },
        { name: "test:run.finish_watcher", timing: "run.finish", priority: 100, fn: postRunFn },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(0);
  });

  it("run.finish allow leaves AgentResult.text unchanged", async () => {
    const events = await collectEvents({
      ...defaultConfig,
      middleware: [
        {
          name: "test:run.finish_observe",
          timing: "run.finish",
          priority: 100,
          fn: () => allow("test.post-run-observe", "observe-result"),
        },
      ],
    });

    const result = getResult(events);
    expect(result?.text).toBe("");
  });
});
