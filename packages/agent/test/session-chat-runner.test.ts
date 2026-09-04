import { describe, expect, it } from "bun:test";
import { createSessionChatRunner, noopSink, type SessionRunnerInput } from "../src/index";
import { createMockLlmConfig, createStopOutcome, mockProviderData, mockProviderModel } from "./helpers/mock-llm";

function input(
  boundary: SessionRunnerInput["boundary"],
  messages: SessionRunnerInput["messages"] = [{ role: "user", text: "initial" }],
): SessionRunnerInput {
  return {
    sessionId: "session-1",
    role: "resident",
    turnId: "turn-1",
    resultId: "result-1",
    parentActionId: null,
    boundaryActionId: null,
    messages,
    tools: [],
    toolsGeneration: 1,
    toolsHash: "tools-hash",
    system: "system",
    systemHash: "system-hash",
    policyGeneration: 0,
    resumeCount: 0,
    signal: new AbortController().signal,
    boundary,
  };
}

function config(run: NonNullable<ReturnType<typeof createMockLlmConfig>>["run"]) {
  return {
    events: noopSink(),
    model: { provider: "anthropic", id: mockProviderModel.id },
    llm: createMockLlmConfig({
      getModels: async () => mockProviderData,
      fromModelsDevModel: () => mockProviderModel,
      run,
    }),
  };
}

const traceContext = { traceId: "trace-1", sessionId: "session-1", runId: "run-1" };

describe("session chat runner", () => {
  it("returns interrupted before invoking the model", async () => {
    let calls = 0;
    const runner = createSessionChatRunner({
      prepare: () => ({
        config: config(async () => {
          calls += 1;
          return createStopOutcome();
        }),
        traceContext,
      }),
    });

    const result = await runner(input(async () => ({ messages: [], interrupted: true })));

    expect(result).toEqual({ kind: "interrupted" });
    expect(calls).toBe(0);
  });

  it("passes boundary messages into the model and returns its terminal result", async () => {
    const modelInputs: string[] = [];
    const boundaries: string[] = [];
    const runner = createSessionChatRunner({
      prepare: () => ({
        config: config(async ({ messages }) => {
          modelInputs.push(JSON.stringify(messages ?? []));
          return createStopOutcome();
        }),
        traceContext,
      }),
    });

    const result = await runner(input(async (boundary) => {
      boundaries.push(boundary);
      return boundary === "before_llm"
        ? { messages: [{ role: "user", text: "steered" }], interrupted: false }
        : { messages: [], interrupted: false };
    }));

    expect(boundaries).toEqual(["before_llm", "after_llm", "after_tools"]);
    expect(modelInputs[0]).toContain('"role":"user"');
    expect(modelInputs[0]).toContain('"text":"initial"');
    expect(modelInputs[0]).toContain('"text":"steered"');
    expect(modelInputs[0]?.indexOf('"text":"initial"')).toBeLessThan(
      modelInputs[0]?.indexOf('"text":"steered"') ?? -1,
    );
    expect(result).toMatchObject({ kind: "result", finishReason: "stop" });
  });

  it("starts another model turn when a post-model boundary supplies continuation", async () => {
    const modelInputs: string[] = [];
    let afterLlm = 0;
    const runner = createSessionChatRunner({
      prepare: () => ({
        config: config(async ({ messages }) => {
          modelInputs.push(JSON.stringify(messages ?? []));
          return createStopOutcome();
        }),
        traceContext,
      }),
    });

    const result = await runner(input(async (boundary) => {
      if (boundary === "after_llm" && afterLlm++ === 0) {
        return { messages: [{ role: "user", text: "continue" }], interrupted: false };
      }
      return { messages: [], interrupted: false };
    }));

    expect(modelInputs).toHaveLength(2);
    expect(modelInputs[1]).toContain('"role":"assistant"');
    expect(modelInputs[1]).toContain('"text":"continue"');
    expect(modelInputs[1]?.indexOf('"role":"assistant"')).toBeLessThan(
      modelInputs[1]?.indexOf('"text":"continue"') ?? -1,
    );
    expect(result.kind).toBe("result");
  });

  it("returns interrupted at either post-model boundary", async () => {
    for (const interruptedAt of ["after_llm", "after_tools"] as const) {
      const runner = createSessionChatRunner({
        prepare: () => ({ config: config(async () => createStopOutcome()), traceContext }),
      });
      const result = await runner(input(async (boundary) => ({
        messages: [],
        interrupted: boundary === interruptedAt,
      })));
      expect(result.kind).toBe("interrupted");
    }
  });

  it("turns reported failures into error results and rethrows unreported failures", async () => {
    const cause = new Error("prepare failed");
    const reported = createSessionChatRunner({
      prepare: () => {
        throw cause;
      },
      reportError: (error) => error === cause ? "reported" : undefined,
    });
    const unreported = createSessionChatRunner({
      prepare: () => {
        throw cause;
      },
    });
    const ready = input(async () => ({ messages: [], interrupted: false }));

    expect(await reported(ready)).toEqual({
      kind: "error",
      text: "reported",
      cause,
      reported: true,
    });
    expect(unreported(ready)).rejects.toBe(cause);
  });
});
