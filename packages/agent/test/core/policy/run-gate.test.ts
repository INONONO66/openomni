import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import type { AgentResult, ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";
import type { PolicyContext } from "../../../src/core/policy";
import {
  createStopOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../../helpers/mock-llm";
import { abortRun, allow, inject } from "../../helpers/policy-decision";
import { runInput } from "../../helpers/run-input";
import { Bus } from "@openomni/telemetry";

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

let runAgent: typeof import("../../../src/core/execution/runner").runAgent;

beforeAll(async () => {
  ({ runAgent } = await import("../../../src/core/execution/runner"));
});

const defaultConfig: ChatAgentConfig = {
  events: Bus,
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  llm: mockLlm,
};

const defaultInput: ChatAgentInput = runInput([{ role: "user", content: "hello" }]);

function runWith(
  config: ChatAgentConfig,
  input: ChatAgentInput = defaultInput,
): Promise<AgentResult> {
  return runAgent(input, config);
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

    await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:run.start",
          pointIds: ["run.lifecycle.pre"],
          effectCapabilities: { "run.lifecycle.pre": [] },
          priority: 100,
          fn: preRunFn,
        },
      ],
    });

    expect(preRunFn).toHaveBeenCalledTimes(1);
    const preRunIdx = callOrder.indexOf("run.start");
    const llmIdx = callOrder.indexOf("llm_turn");
    expect(preRunIdx).toBeGreaterThanOrEqual(0);
    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(preRunIdx).toBeLessThan(llmIdx);
  });

  it("abort → guardAborted: true and no LLM turn", async () => {
    const result = await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:run.start_abort",
          pointIds: ["run.lifecycle.pre"],
          effectCapabilities: { "run.lifecycle.pre": ["run.abort"] },
          priority: 100,
          fn: () => abortRun("test.run-start-abort", "blocked"),
        },
      ],
    });

    expect(result.guardAborted).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(callOrder).not.toContain("llm_turn");
  });

  it("inject → injected message appears in context passed to first LLM turn", async () => {
    const injectedContent = "injected-pre-run-context";

    await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:run.start_inject",
          pointIds: ["run.lifecycle.pre"],
          effectCapabilities: { "run.lifecycle.pre": ["prompt.inject_message"] },
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

    await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:run.finish",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": [] },
          priority: 100,
          fn: postRunFn,
        },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(1);
    const ctx = postRunFn.mock.calls[0]?.[0] as PolicyContext | undefined;
    expect(ctx?.timing).toBe("run.finish");
    expect(ctx?.isCompletion).toBe(true);
    expect(Array.isArray(ctx?.steps)).toBe(true);
  });

  it("reports an honest max-steps outcome after budget exceeded", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    const result = await runWith({
      ...defaultConfig,
      budget: { maxTurns: 0 },
      middleware: [
        {
          kind: "point",
          name: "test:run.finish_budget",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": [] },
          priority: 100,
          fn: postRunFn,
        },
      ],
    });

    expect(result.finishReason).toBe("max-steps");
    expect(postRunFn).toHaveBeenCalledTimes(1);
    expect(Reflect.get(postRunFn.mock.calls[0]?.[0] ?? {}, "runOutcome")).toEqual({
      type: "max-steps",
    });
  });

  it("does NOT fire after turn.start abort", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:turn.start_abort",
          pointIds: ["run.turn.pre"],
          effectCapabilities: { "run.turn.pre": ["run.abort"] },
          priority: 100,
          fn: () => abortRun("test.turn-start-abort", "blocked"),
        },
        {
          kind: "point",
          name: "test:run.finish_watcher",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": [] },
          priority: 100,
          fn: postRunFn,
        },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(0);
  });

  it("does NOT fire after turn.finish abort", async () => {
    const postRunFn = mock((_ctx: PolicyContext) => allow());

    await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:turn.finish_abort",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["run.abort"] },
          priority: 100,
          fn: () => abortRun("test.turn-finish-abort", "blocked"),
        },
        {
          kind: "point",
          name: "test:run.finish_watcher",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": [] },
          priority: 100,
          fn: postRunFn,
        },
      ],
    });

    expect(postRunFn).toHaveBeenCalledTimes(0);
  });

  it("run.finish allow leaves AgentResult.text unchanged", async () => {
    const result = await runWith({
      ...defaultConfig,
      middleware: [
        {
          kind: "point",
          name: "test:run.finish_observe",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": [] },
          priority: 100,
          fn: () => allow("test.post-run-observe", "observe-result"),
        },
      ],
    });

    expect(result.text).toBe("");
  });
});
