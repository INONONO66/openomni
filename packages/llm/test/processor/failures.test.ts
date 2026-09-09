import { describe, expect, test } from "bun:test";
import { LlmCall, type Message, } from "@openomni/protocol";
import { APIError } from "../../src/error";
import { useProcessor, capturingSink, statusStates } from "../helpers/processor";

describe("Processor failures", () => {
  const fixture = useProcessor();
  const { createProcessor, events } = fixture;

test("settles the failed attempt's tool calls before surfacing the failure", async () => {
      let attemptCount = 0;
      const capture = capturingSink();
      const processor = createProcessor({
        sink: capture.sink,
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              yield {
                type: "tool-call",
                toolCallId: "call-attempt-1",
                toolName: "lookup",
                input: {},
              };
              throw new APIError({
                message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
                isRetryable: true,
                responseHeaders: { "retry-after-ms": "1" },
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await expect(processor.process({ system: "", promptText: "" })).rejects.toBeInstanceOf(Error);

      expect(attemptCount).toBe(1);
      // The failed attempt's tool part settles as error inside that attempt's
      // snapshots and never re-emits into the retry attempt (#545 T2).
      const settledToolStates = capture.messages
        .flatMap((message) => message.parts)
        .filter((part): part is Message.ToolPart => part.type === "tool")
        .map((part) => part.state.status);
      expect(settledToolStates).toContain("error");
      expect(capture.finalParts().some((part) => part.type === "tool")).toBe(true);
      expect(capture.toolResults).toHaveLength(1);
      expect(capture.toolResults[0]).toMatchObject({
        toolCallId: "call-attempt-1",
        isError: true,
      });
    });

test("a synchronous provider refusal settles without scheduling another attempt", async () => {
      let calls = 0;
      const error = new APIError({
        message: "retry",
        isRetryable: true,
        responseHeaders: { "retry-after-ms": "0" },
      });
      const processor = createProcessor({
        createStream: () => {
          calls += 1;
          throw error;
        },
      });
      await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
      expect(calls).toBe(1);
      expect(statusStates(events)).toEqual(["busy", "idle"]);
    });

test("respects abort signal during stream processing", async () => {
      const processor = createProcessor();

      fixture.abortController.abort();

      try {
        await processor.process({ system: "", promptText: "" });
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe("AbortError");
      }
    });

test("classifies a custom-reason abort as aborted, not error", async () => {
      // Regression (#audit H1): production callers abort with
      // controller.abort(new Error("cancelled by coordinator")), so
      // throwIfAborted() throws a plain Error — not a DOMException named
      // AbortError. Classifying by error shape alone closed the attempt as
      // finish:"error" (which toModelMessages hides from replay) and marked
      // in-flight tools as failed instead of interrupted.
      const capture = capturingSink();
      const reason = new Error("cancelled by coordinator");
      const processor = createProcessor({
        sink: capture.sink,
        createStream: async () => ({
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "call-abort",
              toolName: "lookup",
              input: {},
            };
            fixture.abortController.abort(reason);
            yield { type: "text-start", providerMetadata: {} };
          })(),
        }),
      });

      try {
        await processor.process({ system: "", promptText: "" });
        expect.unreachable("Should have thrown the abort reason");
      } catch (e) {
        expect(e).toBe(reason);
      }

      // finish:"aborted", not "error" — toModelMessages hides error-finished
      // turns from replay.
      expect(processor.message.finish).toBe("aborted");
      // The pending tool settles as interrupted (the fold projects it onto
      // Tool.StateError with error:"interrupted" — Tool.State has no
      // interrupted status), not as a plain processing error.
      const toolPart = capture
        .finalParts()
        .find((part): part is Message.ToolPart => part.type === "tool");
      expect(toolPart?.state.status).toBe("error");
      if (toolPart?.state.status === "error") {
        expect(toolPart.state.error).toBe("interrupted");
      }
    });

test("retains inferred-reset failure for the executor without owning backoff", async () => {
      const error = new APIError({
        message: "slow down",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: { "anthropic-ratelimit-requests-reset": "120s" },
      });
      const processor = createProcessor({
        createStream: async () => {
          throw error;
        },
      });
      await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
      expect(events.named(LlmCall.Events.RetryDecided.name)).toEqual([]);
      expect(processor.message.finish).toBe("error");
    });

test("propagates raw AI SDK provider errors after exactly one attempt", async () => {
      let attemptCount = 0;
      const sdkError = Object.assign(new Error("Overloaded"), {
        name: "AI_APICallError",
        isRetryable: true,
        statusCode: 529,
        responseHeaders: { "Retry-After-Ms": "1" },
      });

      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw sdkError;
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await expect(processor.process({ system: "", promptText: "" })).rejects.toBeInstanceOf(Error);

      expect(attemptCount).toBe(1);
    });

test("propagates retryable errors without scheduling another attempt", async () => {
      let attemptCount = 0;

      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw new APIError({
                message: JSON.stringify({
                  type: "error",
                  error: { type: "too_many_requests" },
                }),
                isRetryable: true,
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await expect(processor.process({ system: "", promptText: "" })).rejects.toBeInstanceOf(Error);

      expect(attemptCount).toBe(1);
    });

test("preserves the Anthropic 429 identity for canonical retry classification", async () => {
      const error = new APIError({
        message: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }),
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { "retry-after-ms": "1" },
      });
      const processor = createProcessor({
        createStream: async () => {
          throw error;
        },
      });
      await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
      expect(processor.message.finish).toBe("error");
    });

test("throws original error instance for non-retryable errors and settles cleanly", async () => {
      const capture = capturingSink();

      const errorInstance = new APIError({
        message: "Specific error",
        statusCode: 500,
        isRetryable: false,
      });

      const processor = createProcessor({
        sink: capture.sink,
        createStream: async () => ({
          fullStream: (async function* (shouldThrow = true) {
            yield { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} };
            if (shouldThrow) throw errorInstance;
          })(),
        }),
      });

      try {
        await processor.process({ system: "", promptText: "" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBe(errorInstance);
      }

      // Exactly one idle transition, and the pending tool is closed out once.
      expect(statusStates(events)).toEqual(["busy", "idle"]);
      expect(capture.toolResults).toHaveLength(1);
      expect(capture.toolResults[0]).toMatchObject({
        toolCallId: "call-1",
        output: "Processing was interrupted",
        isError: true,
      });
      const toolPart = capture
        .finalParts()
        .find((part): part is Message.ToolPart => part.type === "tool");
      expect(toolPart?.state.status).toBe("error");
    });
});
