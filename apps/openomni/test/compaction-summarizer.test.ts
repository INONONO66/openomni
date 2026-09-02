import { describe, expect, it } from "bun:test";
import type { LlmIo } from "../src/tools/execution/llm";
import { Run } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import { createCompactionSummarizer, SummarizerError } from "../src/compaction/summarizer";

const MODEL = { provider: "fake", id: "summary-model", apiKey: "key" };
const BUDGET = { contextWindowTokens: 100_000, maxInputTokens: 50_000, maxOutputTokens: 20_000 };

function message(id: string, text: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "session",
      role: "assistant",
      time: { created: 1 },
      parentID: "parent",
      modelID: "summary-model",
      providerID: "fake",
      agent: "resident",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [{ id: `${id}-part`, sessionID: "session", messageID: id, type: "text", text }],
  };
}

function answer(text: string): Message.WithParts {
  return message("answer", text);
}

const resolveProviderModel: NonNullable<LlmIo["resolveProviderModel"]> = async (model) => ({
  id: model.id,
  name: model.id,
  providerID: model.provider,
});

function runFailure(contextOverflow: boolean, message: string): Run.Failure {
  return new Run.FailureError({
    message,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    aborted: false,
    contextOverflow,
  });
}

describe("production compaction summarizer", () => {
  it("merges the previous anchor without tools and bounds output tokens", async () => {
    let captured: Parameters<NonNullable<LlmIo["run"]>>[0] | undefined;
    const run: NonNullable<LlmIo["run"]> = async (input, sink) => {
      captured = input;
      sink.onMessage(answer("dense merged summary"));
      return { type: "stop" };
    };
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveProviderModel } });

    await expect(summarize([message("m1", "new span")], "prior anchor", BUDGET)).resolves.toBe(
      "dense merged summary",
    );
    expect(captured?.tools).toEqual([]);
    expect(captured?.toolChoice).toBe("none");
    expect(captured?.maxTokens).toBe(20_000);
    expect(captured?.providerOptions).toEqual({ openai: { reasoningEffort: "minimal" } });
    const prompt = captured?.messages[0]?.parts[0];
    expect(prompt?.type === "text" ? prompt.text : "").toContain("prior anchor");
  });

  it("throws a typed empty error for an empty model response", async () => {
    const run: NonNullable<LlmIo["run"]> = async (_input, sink) => {
      sink.onMessage(answer("   "));
      return { type: "stop" };
    };
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveProviderModel } });

    const error = await summarize([message("m1", "span")], undefined, BUDGET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SummarizerError);
    expect((error as SummarizerError).kind).toBe("empty");
  });

  it("uses the typed overflow flag to shrink twice before a typed overflow error", async () => {
    const inputLengths: number[] = [];
    const failure = runFailure(true, "opaque upstream failure");
    const run: NonNullable<LlmIo["run"]> = async (input) => {
      inputLengths.push(input.messages.length);
      return { type: "error", error: failure };
    };
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveProviderModel } });

    const error = await summarize(
      [message("m1", "oldest"), message("m2", "middle"), message("m3", "newest")],
      undefined,
      BUDGET,
    ).catch((caught: unknown) => caught);
    expect(inputLengths).toEqual([4, 3, 2]);
    expect(error).toBeInstanceOf(SummarizerError);
    expect((error as SummarizerError).kind).toBe("overflow");
  });

  it("does not retry overflow prose when the typed flag is false", async () => {
    let calls = 0;
    const failure = runFailure(false, "context window has been exceeded");
    const run: NonNullable<LlmIo["run"]> = async () => {
      calls += 1;
      return { type: "error", error: failure };
    };
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveProviderModel } });

    const error = await summarize([message("m1", "span")], undefined, BUDGET).catch(
      (caught: unknown) => caught,
    );
    expect(calls).toBe(1);
    expect(error).toBe(failure);
  });

  it("surfaces an aborted run as AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const run: NonNullable<LlmIo["run"]> = async (input) => {
      expect(input.signal).toBe(controller.signal);
      return { type: "aborted" };
    };
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveProviderModel } });

    const error = await summarize(
      [message("m1", "span")],
      undefined,
      BUDGET,
      controller.signal,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(SummarizerError);
  });
});
