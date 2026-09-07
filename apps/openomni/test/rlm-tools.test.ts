import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createTools, collectToolSpecs } from "../src/tools/core/catalog";
import { createDispatcher, toolSpec } from "@openomni/agent";
import {
  createCompletionPort as completionPort,
  COMPLETION_TOOL_NAME,
  MAX_COMPLETION_CALLS,
} from "../src/tools/completion";
import { Auth, ModelsDev, Provider, type RunInput } from "@openomni/llm";

afterEach(() => mock.restore());
import { assistantMessage } from "./helpers/assistant-message";
import { providerFailure } from "./helpers/provider-failure";
import { executor } from "./helpers/executor";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

import { admittedOperation } from "./helpers/admitted-operation";

function createCompletionPort(...args: Parameters<typeof completionPort>) {
  const port = completionPort(...args);
  return (prompt: string) => admittedOperation(() => port(prompt));
}

const RESIDENT = { role: "resident", depth: 0, sessionId: "session-origin" } as const;

describe("the completion tool", () => {
  it("returns the port's answer", async () => {
    const run = modelToolOutput(
      COMPLETION_TOOL_NAME,
      { llm: async (prompt) => `answered: ${prompt}` },
      RESIDENT,
    );
    expect(await run({ prompt: "summarize this" })).toBe("answered: summarize this");
  });

  it("classifies a malformed call as invalid input without touching the port", async () => {
    let invoked = 0;
    const run = dispatchModelTool(
      COMPLETION_TOOL_NAME,
      {
        llm: async () => {
          invoked += 1;
          return "x";
        },
      },
      RESIDENT,
    );
    expect(await run({ prompt: "" })).toMatchObject({
      isError: true,
      errorKind: "invalid_input",
    });
    expect(await run({ prompt: "ok", extra: true })).toMatchObject({
      isError: true,
      errorKind: "invalid_input",
    });
    expect(invoked).toBe(0);
  });

  it(`serves ${MAX_COMPLETION_CALLS} calls, then classifies refusal without invoking the port`, async () => {
    let invoked = 0;
    const run = dispatchModelTool(
      COMPLETION_TOOL_NAME,
      {
        llm: async () => {
          invoked += 1;
          return `call ${invoked}`;
        },
      },
      RESIDENT,
    );

    for (let i = 1; i <= MAX_COMPLETION_CALLS; i++) {
      const result = await run({ prompt: `q${i}` });
      expect(result.output).toBe(`call ${i}`);
      expect(result.isError).toBeUndefined();
    }

    expect(await run({ prompt: "one too many" })).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
      output: `completion refused: the per-cell budget of ${MAX_COMPLETION_CALLS} sub-model calls is spent`,
    });
    expect(invoked).toBe(MAX_COMPLETION_CALLS);
  });

  it("surfaces a failure as an error RESULT through the dispatcher, never as data", async () => {
    // The defect this pins: a failing llm call returned as a completed string
    // lets cell code store failure text as if it were model output. The
    // dispatcher must mark it isError so the cell door raises ToolError.
    const entries = createTools(
      {
        llm: async () => {
          throw new Error("llm failed: provider on fire");
        },
      },
      RESIDENT,
    );
    const dispatcher = createDispatcher(entries, { executor });

    const result = await dispatcher.execute(
      { id: "1", tool: COMPLETION_TOOL_NAME, input: { prompt: "hi" } },
      { sessionId: "rlm-session", turnId: "rlm-turn" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toBe("llm failed: provider on fire");
  });

  it("refuses an unlisted model instead of guessing an SDK for it", async () => {
    // The defect this pins: a bare fallback model dropped the provider's npm
    // wiring, and the LLM package then routed an anthropic credential to the
    // OpenAI SDK. Unlisted must be a per-call error.
    const catalog = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        api: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
        env: [],
        models: {
          listed: { id: "listed", name: "Listed" },
        },
      },
    };
    spyOn(ModelsDev, "get").mockResolvedValue(catalog);
    spyOn(Auth, "get").mockResolvedValue(undefined);
    const run = mock(async () => ({ type: "stop" as const }));
    expect(await Provider.resolveModel({ provider: "anthropic", id: "listed" })).toMatchObject({
      id: "listed",
      providerID: "anthropic",
      api: { npm: "@ai-sdk/anthropic" },
    });
    for (const [provider, id, reason] of [
      ["anthropic", "claude-unlisted", "model_not_found"],
      ["nowhere", "listed", "provider_not_found"],
    ] as const) {
      await expect(
        createCompletionPort({ provider, id, apiKey: "key" }, { run })("hello"),
      ).rejects.toMatchObject({
        data: { reason, provider, model: id },
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("dispatches the cell door without a target eligibility fold", async () => {
    const entries = createTools({ llm: async () => "ok" }, RESIDENT);
    const dispatcher = createDispatcher(entries, { executor });
    const result = await dispatcher.executeCell(
      { id: "1", tool: COMPLETION_TOOL_NAME, input: { prompt: "hi" } },
      { sessionId: "rlm-session", turnId: "rlm-turn" },
    );
    expect(result.isError).toBeUndefined();
    expect(result.output).toEqual("ok");
  });
});

describe("the completion port", () => {
  const MODEL = { provider: "fake", id: "port-test", apiKey: "port-key" } as const;
  const resolveModel = async (model: { provider: string; id: string }) => ({
    id: model.id,
    name: model.id,
    providerID: model.provider,
  });

  it("runs one toolless step under its own trace and returns the assistant text", async () => {
    let seen: RunInput | undefined;
    const port = createCompletionPort(MODEL, {
      resolveModel,
      run: async (input, sink) => {
        seen = input;
        sink.onMessage(assistantMessage(input, { id: "sub-reply", text: "the answer" }));
        return { type: "stop" };
      },
    });

    expect(await port("summarize")).toBe("the answer");
    expect(seen?.tools).toEqual([]);
    expect(seen?.maxSteps).toBe(1);
    expect(seen?.auth).toEqual({ type: "api", key: "port-key" });
    expect(seen?.model).toMatchObject({ id: "port-test", providerID: "fake" });
    // A nested run must never borrow the turn's identity: the trace is its own.
    expect(seen?.trace.sessionId).toBe("completion");
    const parts = seen?.messages[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ type: "text", text: "summarize" });
  });

  it("ignores non-assistant messages when reading the answer", async () => {
    const port = createCompletionPort(MODEL, {
      resolveModel,
      run: async (input, sink) => {
        const echo = input.messages[0];
        if (echo !== undefined) sink.onMessage(echo);
        // The port discards tool activity too: a one-step toolless run has no
        // executor, so these projections must be inert.
        sink.onToolCall({ id: "call-1", tool: "noop", input: {} });
        sink.onToolResult({ id: "result-1", toolCallId: "call-1", output: "ignored" });
        return { type: "stop" };
      },
    });

    expect(await port("anything")).toBe("");
  });

  it("throws the provider's failure instead of returning it as data", async () => {
    const port = createCompletionPort(MODEL, {
      resolveModel,
      run: async () => ({ type: "error", error: providerFailure("provider on fire") }),
    });

    await expect(port("q")).rejects.toThrow("provider on fire");
  });

  it("names the outcome when a non-stop run carries no error", async () => {
    const port = createCompletionPort(MODEL, {
      resolveModel,
      run: async () => ({ type: "aborted" }),
    });

    await expect(port("q")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("catalog gating for the rlm tools", () => {
  it("lists the completion spec in the shippable surface the lint reads", () => {
    const names = collectToolSpecs().map((spec) => spec.name);
    expect(names).toContain(COMPLETION_TOOL_NAME);
  });

  it("stays in the static catalog without a wired port and refuses at execution", async () => {
    const names = createTools({}, RESIDENT).map((entry) => entry.name);
    expect(names).toContain(COMPLETION_TOOL_NAME);
    const result = await createDispatcher(createTools({}, RESIDENT), { executor }).executeCell(
      { id: "unwired", tool: COMPLETION_TOOL_NAME, input: { prompt: "x" } },
      { sessionId: RESIDENT.sessionId, turnId: "turn" },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toBe("completion refused: sub-model port is not composed");
  });

  it("projects completion without target metadata", () => {
    const specs = createTools({ llm: async () => "" }, RESIDENT).map((entry) => toolSpec(entry));
    expect(specs.map((spec) => spec.name)).toContain(COMPLETION_TOOL_NAME);
    expect(specs.every((spec) => spec.placement === undefined)).toBe(true);
  });
});
