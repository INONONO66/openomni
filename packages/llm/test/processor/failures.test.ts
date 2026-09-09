import { describe, expect, mock, test } from "bun:test";
import { LlmCall } from "@openomni/protocol";
import { APIError } from "../../src/error";
import { useProcessor, capturingSink, failingStream, statusStates } from "../helpers/processor";
import type { StreamEvent } from "../../src/processor/stream-events";

describe("Processor failures", () => {
  const fixture = useProcessor();
  const { createProcessor, events } = fixture;

  test("settles the failed attempt's tool calls before surfacing the failure", async () => {
    const error = new APIError({ message: "failure fixture", isRetryable: true });
    const stream = failingStream(error, [
      { type: "tool-call", toolCallId: "call-attempt-1", toolName: "lookup", input: {} },
    ]);
    const capture = capturingSink();
    const processor = createProcessor({ sink: capture.sink, createStream: stream });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(capture.finalParts()).toMatchObject([{ type: "tool", state: { status: "error" } }]);
    expect(capture.toolResults).toMatchObject([{ toolCallId: "call-attempt-1", isError: true }]);
  });

  test("a synchronous provider refusal settles without scheduling another attempt", async () => {
    const error = new APIError({
      message: "failure fixture",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "0" },
    });
    const stream = mock(() => {
      throw error;
    });
    const processor = createProcessor({ createStream: stream });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(statusStates(events)).toEqual(["busy", "idle"]);
  });

  test("respects an already-aborted signal", async () => {
    const processor = createProcessor();
    fixture.abortController.abort();
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("classifies a custom-reason abort as aborted, not error", async () => {
    const reason = new Error("abort fixture");
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "tool-call", toolCallId: "call-abort", toolName: "lookup", input: {} };
          fixture.abortController.abort(reason);
          yield { type: "text-start" };
        })(),
      }),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(reason);
    expect(processor.message.finish).toBe("aborted");
    expect(capture.finalParts()).toMatchObject([
      { type: "tool", state: { status: "error", error: "interrupted" } },
    ]);
  });

  test("retains inferred-reset failure for the executor without owning backoff", async () => {
    const error = new APIError({
      message: "failure fixture",
      isRetryable: true,
      statusCode: 429,
      responseHeaders: { "anthropic-ratelimit-requests-reset": "120s" },
    });
    const processor = createProcessor({ createStream: failingStream(error) });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(events.named(LlmCall.Events.RetryDecided.name)).toEqual([]);
    expect(processor.message.finish).toBe("error");
  });

  test.each([
    Object.assign(new Error("SDK fixture"), {
      name: "AI_APICallError",
      isRetryable: true,
      statusCode: 529,
      responseHeaders: { "Retry-After-Ms": "1" },
    }),
    new APIError({
      message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
      isRetryable: true,
    }),
  ])("propagates %s after exactly one attempt", async (error) => {
    const stream = failingStream(error);
    const processor = createProcessor({ createStream: stream });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  test("preserves the Anthropic 429 identity for canonical classification", async () => {
    const error = new APIError({
      message: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }),
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "1" },
    });
    const processor = createProcessor({ createStream: failingStream(error) });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(processor.message.finish).toBe("error");
  });

  test("throws the original non-retryable error and settles its tool once", async () => {
    const error = new APIError({ message: "failure fixture", statusCode: 500, isRetryable: false });
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: failingStream(error, [
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} },
      ]),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(statusStates(events)).toEqual(["busy", "idle"]);
    expect(capture.toolResults).toMatchObject([
      { toolCallId: "call-1", output: "Processing was interrupted", isError: true },
    ]);
    expect(capture.finalParts()).toMatchObject([{ type: "tool", state: { status: "error" } }]);
  });
});
