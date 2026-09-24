import { Effect } from "effect";
import { describe, expect, it } from "bun:test";
import { Llm } from "@openomni/llm";
import { Bus, ObservationSink } from "@openomni/agent";
import type { FixtureLlm } from "./helpers/app-fixture";
import { LlmRunFailure, type Run } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import {
  createCompactionSummarizer as summarizer,
  SummarizerError,
} from "../src/compaction/summarizer";
import { ExecutorContext } from "@openomni/agent";
import { executor } from "./helpers/executor";
import { runEffect, runSyncEffect } from "./helpers/effect";

function createCompactionSummarizer(config: Parameters<typeof summarizer>[0] & { readonly io: FixtureLlm }) {
  const run = runSyncEffect(summarizer(config).pipe(Effect.provideService(Llm, config.io), Effect.provideService(ObservationSink, Bus)));
  return (...args: Parameters<typeof run>) => Effect.provideService(run(...args), ExecutorContext, executor);
}

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

const resolveModel: NonNullable<FixtureLlm["resolveModel"]> = (model) => Effect.succeed({
  id: model.id,
  name: model.id,
  providerID: model.provider,
});

function runFailure(contextOverflow: boolean, message: string): Run.Failure {
  return new LlmRunFailure({
    visibleOutput: false,
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
    let captured: Parameters<NonNullable<FixtureLlm["run"]>>[0] | undefined;
    const run: NonNullable<FixtureLlm["run"]> = (input, sink) => Effect.sync(() => {
      captured = input;
      sink.onMessage(answer("dense merged summary"));
      return { type: "stop" };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveModel } });

    await expect(runEffect(summarize([message("m1", "new span")], "prior anchor", BUDGET))).resolves.toBe(
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
    const run: NonNullable<FixtureLlm["run"]> = (_input, sink) => Effect.sync(() => {
      sink.onMessage(answer("   "));
      return { type: "stop" };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveModel } });

    const error = await runEffect(Effect.flip(summarize([message("m1", "span")], undefined, BUDGET)));
    expect(error).toBeInstanceOf(SummarizerError);
    expect(error).toMatchObject({ _tag: "ForeignFailure", kind: "empty" });
  });

  it("uses the typed overflow flag to shrink twice before a typed overflow error", async () => {
    const inputLengths: number[] = [];
    const failure = runFailure(true, "opaque upstream failure");
    const run: NonNullable<FixtureLlm["run"]> = (input) => Effect.sync(() => {
      inputLengths.push(input.messages.length);
      return { type: "error", error: failure };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveModel } });

    const error = await runEffect(Effect.flip(summarize(
      [message("m1", "oldest"), message("m2", "middle"), message("m3", "newest")],
      undefined,
      BUDGET,
    )));
    expect(inputLengths).toEqual([4, 3, 2]);
    expect(error).toBeInstanceOf(SummarizerError);
    expect(error).toMatchObject({ _tag: "ForeignFailure", kind: "overflow" });
  });

  it("does not retry overflow prose when the typed flag is false", async () => {
    let calls = 0;
    const failure = runFailure(false, "context window has been exceeded");
    const run: NonNullable<FixtureLlm["run"]> = () => Effect.sync(() => {
      calls += 1;
      return { type: "error", error: failure };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveModel } });

    const error = await runEffect(Effect.flip(summarize([message("m1", "span")], undefined, BUDGET)));
    expect(calls).toBe(1);
    expect(error).toBe(failure);
  });

  it.each([false, true])("surfaces an aborted run as Interrupted (pre-aborted=%s)", async (preAborted) => {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    let calls = 0;
    const run: NonNullable<FixtureLlm["run"]> = (input) => Effect.sync(() => {
      calls += 1;
      expect(input.signal).toBe(controller.signal);
      return { type: "aborted" };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, io: { run, resolveModel } });

    const error = await runEffect(Effect.flip(summarize(
      [message("m1", "span")],
      undefined,
      BUDGET,
      controller.signal,
    )));
    expect(error).toMatchObject({ _tag: "Interrupted" });
    expect(calls).toBe(preAborted ? 0 : 1);
    expect(error).not.toBeInstanceOf(SummarizerError);
  });
});
