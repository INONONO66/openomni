import { describe, expect, it } from "bun:test";
import { placementGatedExecutor } from "@openomni/agent";
import { Placement } from "@openomni/placement";
import { createTools, collectToolSpecs } from "../src/tools/core/catalog";
import { createDispatcher, HOST_TARGET } from "../src/tools/core/dispatch";
import { toolSpec } from "../src/tools/core/project";
import {
  createLlmToolPort,
  LLM_TOOL_NAME,
  MAX_LLM_CALLS,
  resolveLlmToolModel,
} from "../src/tools/execution/llm";
import type { RunInput } from "@openomni/llm";
import { assistantMessage } from "./helpers/assistant-message";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

const RESIDENT = { role: "resident", depth: 0, sessionId: "session-origin" } as const;

describe("the llm tool", () => {
  it("returns the port's answer", async () => {
    const run = modelToolOutput(
      LLM_TOOL_NAME,
      { llm: async (prompt) => `answered: ${prompt}` },
      RESIDENT,
    );
    expect(await run({ prompts: ["summarize this"] })).toBe('["answered: summarize this"]');
  });

  it("classifies a malformed call as invalid input without touching the port", async () => {
    let invoked = 0;
    const run = dispatchModelTool(
      LLM_TOOL_NAME,
      {
        llm: async () => {
          invoked += 1;
          return "x";
        },
      },
      RESIDENT,
    );
    expect(await run({ prompts: [""] })).toMatchObject({
      isError: true,
      errorClass: "invalid_input",
    });
    expect(await run({ prompts: ["ok"], extra: true })).toMatchObject({
      isError: true,
      errorClass: "invalid_input",
    });
    expect(invoked).toBe(0);
  });

  it(`serves ${MAX_LLM_CALLS} calls, then classifies refusal without invoking the port`, async () => {
    let invoked = 0;
    const run = dispatchModelTool(
      LLM_TOOL_NAME,
      {
        llm: async () => {
          invoked += 1;
          return `call ${invoked}`;
        },
      },
      RESIDENT,
    );

    for (let i = 1; i <= MAX_LLM_CALLS; i++) {
      const result = await run({ prompts: [`q${i}`] });
      expect(result.output).toBe(`["call ${i}"]`);
      expect(result.isError).toBeUndefined();
    }

    expect(await run({ prompts: ["one too many"] })).toMatchObject({
      isError: true,
      errorClass: "precondition_failed",
      output: `llm refused: the per-cell budget of ${MAX_LLM_CALLS} sub-model calls is spent`,
    });
    expect(invoked).toBe(MAX_LLM_CALLS);
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
    const dispatcher = createDispatcher(entries);

    const result = await dispatcher.execute({
      id: "1",
      tool: LLM_TOOL_NAME,
      input: { prompts: ["hi"] },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("llm failed: provider on fire");
  });

  it("refuses an unlisted model instead of guessing an SDK for it", () => {
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
    } as never;

    expect(resolveLlmToolModel(catalog, { provider: "anthropic", id: "listed" })).toMatchObject({
      id: "listed",
      providerID: "anthropic",
      api: { npm: "@ai-sdk/anthropic" },
    });
    expect(() =>
      resolveLlmToolModel(catalog, { provider: "anthropic", id: "claude-unlisted" }),
    ).toThrow('llm failed: model "claude-unlisted" is not listed under provider "anthropic"');
    expect(() => resolveLlmToolModel(catalog, { provider: "nowhere", id: "listed" })).toThrow(
      "llm failed:",
    );
  });

  it("is host-placed: it survives the cell-door fold against the brain alone", async () => {
    const entries = createTools({ llm: async () => "ok" }, RESIDENT);
    const dispatcher = createDispatcher(entries);
    // The exact fold run-code.ts's cellDoor performs: resolve against the
    // host target only, then gate execution on the offerable set.
    const door = placementGatedExecutor(
      Placement.resolveTools(dispatcher.specs, [HOST_TARGET]),
      dispatcher.execute,
    );

    const result = await door({ id: "1", tool: LLM_TOOL_NAME, input: { prompts: ["hi"] } });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('["ok"]');
  });
});

describe("the llm tool port", () => {
  const MODEL = { provider: "fake", id: "port-test", apiKey: "port-key" } as const;
  const resolveProviderModel = async (model: { provider: string; id: string }) => ({
    id: model.id,
    name: model.id,
    providerID: model.provider,
  });

  it("runs one toolless step under its own trace and returns the assistant text", async () => {
    let seen: RunInput | undefined;
    const port = createLlmToolPort(MODEL, {
      resolveProviderModel,
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
    expect(seen?.trace.sessionId).toBe("llm-tool");
    const parts = seen?.messages[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ type: "text", text: "summarize" });
  });

  it("ignores non-assistant messages when reading the answer", async () => {
    const port = createLlmToolPort(MODEL, {
      resolveProviderModel,
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
    const port = createLlmToolPort(MODEL, {
      resolveProviderModel,
      run: async () => ({ type: "error", error: new Error("provider on fire") }),
    });

    await expect(port("q")).rejects.toThrow("llm failed: provider on fire");
  });

  it("names the outcome when a non-stop run carries no error", async () => {
    const port = createLlmToolPort(MODEL, {
      resolveProviderModel,
      run: async () => ({ type: "aborted" }),
    });

    await expect(port("q")).rejects.toThrow("llm failed: the sub-model run ended as aborted");
  });
});

describe("catalog gating for the rlm tools", () => {
  it("lists the llm spec in the shippable surface the lint reads", () => {
    const names = collectToolSpecs().map((spec) => spec.name);
    expect(names).toContain(LLM_TOOL_NAME);
  });

  it("is absent from the catalog when the ports are not wired", () => {
    const names = createTools({}, RESIDENT).map((entry) => entry.name);
    expect(names).not.toContain(LLM_TOOL_NAME);
  });

  it("appears when the port is wired", () => {
    const names = createTools({ llm: async () => "" }, RESIDENT).map((entry) => entry.name);
    expect(names).toContain(LLM_TOOL_NAME);
  });

  it("offers llm on the host target", () => {
    const specs = createTools({ llm: async () => "" }, RESIDENT).map((entry) => toolSpec(entry));
    const offerable = Placement.resolveTools(specs, [HOST_TARGET])
      .filter((decision) => decision.offerable)
      .map((decision) => decision.tool.name);
    expect(offerable).toContain(LLM_TOOL_NAME);
  });
});
