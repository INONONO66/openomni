import { describe, expect, test } from "bun:test";
import { APIError } from "../../src/error";
import type { Provider } from "../../src/provider";
import type { EstimateUsage } from "../../src/token";
import { useProcessor, capturingSink, streamOf } from "../helpers/processor";

describe("Processor accounting", () => {
  const fixture = useProcessor();
  const { createProcessor } = fixture;

describe("unusable provider accounting", () => {
      const SENTINEL: ReturnType<EstimateUsage> = { inputTokens: 13, outputTokens: 17 };
      const sentinelEstimator: EstimateUsage = () => SENTINEL;

      /**
       * What a provider can actually put in a usage slot: a count, a
       * stringified count, an explicit null, or a boolean. Concrete on purpose
       * — the malformed values under test are enumerated, not erased.
       */
      type ReportedCount = number | string | null | boolean;
      type ReportedUsage = Partial<
        Record<"inputTokens" | "input_tokens" | "outputTokens" | "output_tokens", ReportedCount>
      >;

      function processStep(usage: ReportedUsage | undefined) {
        return createProcessor({
          estimateUsage: sentinelEstimator,
          createStream: streamOf([
            { type: "step-start" },
            {
              type: "step-finish",
              finishReason: "end_turn",
              ...(usage === undefined ? {} : { usage }),
              providerMetadata: {},
            },
            { type: "finish" },
          ]),
        });
      }

      test("substitutes the estimate when provider usage is absent", async () => {
        const processor = processStep(undefined);

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens).toEqual({
          input: SENTINEL.inputTokens,
          output: SENTINEL.outputTokens,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
        expect(processor.usageTotals).toEqual({
          input: SENTINEL.inputTokens,
          output: SENTINEL.outputTokens,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
      });

      test.each([
        ["string", { inputTokens: "100", outputTokens: "50" }],
        ["null", { inputTokens: null, outputTokens: null }],
        ["boolean", { inputTokens: false, outputTokens: true }],
      ])("substitutes the estimate for wrong-typed (%s) provider usage", async (_name, usage) => {
        const processor = processStep(usage);

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(SENTINEL.inputTokens);
        expect(processor.message.tokens.output).toBe(SENTINEL.outputTokens);
      });

      test.each([
        ["negative", -1],
        ["NaN", Number.NaN],
        ["infinite", Number.POSITIVE_INFINITY],
        ["fractional", 1.5],
        ["unsafe", Number.MAX_SAFE_INTEGER + 1],
      ])("substitutes the estimate for invalid numeric (%s) provider usage", async (_name, value) => {
        const capture = capturingSink();
        const processor = createProcessor({
          sink: capture.sink,
          estimateUsage: sentinelEstimator,
          createStream: streamOf([
            { type: "step-start" },
            {
              type: "step-finish",
              finishReason: "end_turn",
              usage: { inputTokens: value, outputTokens: value },
              providerMetadata: {},
            },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(SENTINEL.inputTokens);
        expect(processor.message.tokens.output).toBe(SENTINEL.outputTokens);
        // The fold completes: invalid accounting no longer aborts the step.
        expect(capture.finalParts().some((part) => part.type === "step-finish")).toBe(true);
      });

      test("keeps a reported zero authoritative instead of estimating", async () => {
        const processor = processStep({
          inputTokens: 0,
          input_tokens: 11,
          outputTokens: 0,
          output_tokens: 10,
        });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens).toEqual({
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
      });

      test("substitutes per required field, keeping the usable one", async () => {
        const processor = processStep({ inputTokens: 7, outputTokens: "nope" });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(7);
        expect(processor.message.tokens.output).toBe(SENTINEL.outputTokens);
      });

      test("keeps multi-step totals additive across estimated and reported steps", async () => {
        const processor = createProcessor({
          estimateUsage: sentinelEstimator,
          createStream: streamOf([
            { type: "step-finish", finishReason: "tool_use", usage: {} },
            {
              type: "step-finish",
              finishReason: "end_turn",
              usage: { inputTokens: 1000, outputTokens: 500 },
            },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "prompt" });

        expect(processor.message.tokens.input).toBe(1000 + SENTINEL.inputTokens);
        expect(processor.message.tokens.output).toBe(500 + SENTINEL.outputTokens);
      });

      test("defaults to the ceil(chars/4) estimator when none is injected", async () => {
        const promptText = "0123456789"; // 10 chars → ceil(10/4) = 3
        const processor = createProcessor({
          createStream: streamOf([
            { type: "text-start", providerMetadata: {} },
            { type: "text-delta", text: "01234" }, // 5 chars → ceil(5/4) = 2
            { type: "text-end", providerMetadata: {} },
            { type: "step-finish", finishReason: "end_turn", usage: {} },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText });

        expect(processor.message.tokens.input).toBe(3);
        expect(processor.message.tokens.output).toBe(2);
      });

      test("counts reasoning and tool-call emission in the estimated output", async () => {
        // Default estimator (ceil(chars/4)). The step emits no text: 8 chars of
        // reasoning plus a tool call serialized as name + JSON input
        // ("read" + '{"path":"a"}' = 16 chars). Provider reports nothing usable,
        // so the estimate must be ceil(24/4) = 6 - dropping either contribution
        // yields 2 or 4 and fails here.
        const processor = createProcessor({
          createStream: streamOf([
            { type: "reasoning-start", id: "r1", providerMetadata: {} },
            { type: "reasoning-delta", id: "r1", text: "01234567" },
            { type: "reasoning-end", id: "r1", providerMetadata: {} },
            { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } },
            { type: "step-finish", finishReason: "tool_use", usage: {} },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "" });

        expect(processor.message.tokens.output).toBe(6);
      });

      test("estimates each step's output from that step's emission only", async () => {
        // Default estimator, so the output estimate reads the step's own
        // emitted assistant text. Step 1 emits 8 chars and reports usable
        // counts; step 2 emits 4 chars and reports nothing usable. Step 2's
        // estimate must cover step 2's 4 chars (ceil(4/4) = 1), not the 12
        // accumulated chars (ceil(12/4) = 3) - the per-step reset is what
        // keeps multi-step totals additive.
        const processor = createProcessor({
          createStream: streamOf([
            { type: "step-start" },
            { type: "text-start", providerMetadata: {} },
            { type: "text-delta", text: "01234567" },
            { type: "text-end", providerMetadata: {} },
            {
              type: "step-finish",
              finishReason: "tool_use",
              usage: { inputTokens: 1000, outputTokens: 500 },
            },
            { type: "step-start" },
            { type: "text-start", providerMetadata: {} },
            { type: "text-delta", text: "89ab" },
            { type: "text-end", providerMetadata: {} },
            { type: "step-finish", finishReason: "end_turn", usage: {} },
            { type: "finish" },
          ]),
        });

        await processor.process({ system: "", promptText: "0123456789" });

        expect(processor.message.tokens.output).toBe(500 + 1);
        // Input for the estimated step is the turn-initial prompt (10 chars -> 3).
        expect(processor.message.tokens.input).toBe(1000 + 3);
      });
    });

test("keeps local cost at zero and accumulates AI SDK token usage", async () => {
      const model: Provider.Model = {
        id: "claude-opus-4-5",
        providerID: "anthropic",
        name: "Claude Opus",
      };

      const processor = createProcessor({
        model,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.providerID).toBe("anthropic");
      expect(processor.message.modelID).toBe("claude-3-5-sonnet");
      expect(processor.message.tokens.input).toBe(10000);
      expect(processor.message.tokens.output).toBe(5000);
    });

test("keeps cost at zero for non-anthropic models too", async () => {
      const model: Provider.Model = {
        id: "gpt-4o",
        providerID: "openai",
        name: "GPT-4o",
      };

      const processor = createProcessor({
        model,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "stop",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.tokens.input).toBe(10000);
      expect(processor.message.tokens.output).toBe(5000);
    });

test("usageTotals retains billed usage on a failed attempt", async () => {
      // Regression (#audit M3): LlmCall.Events.Completed read message.tokens — the
      // final attempt's fold — so a retried attempt's billed tokens vanished
      // from telemetry. usageTotals must carry every attempt.
      let attemptCount = 0;
      const processor = createProcessor({
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              yield {
                type: "step-finish",
                finishReason: "stop",
                usage: { inputTokens: 100, outputTokens: 40 },
                providerMetadata: {},
              };
              throw new APIError({
                message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
                isRetryable: true,
                responseHeaders: { "retry-after-ms": "1" },
              });
            }
            yield {
              type: "step-finish",
              finishReason: "end_turn",
              usage: { inputTokens: 200, outputTokens: 60 },
              providerMetadata: {},
            };
            yield { type: "finish" };
          })(),
        }),
      });

      await expect(processor.process({ system: "", promptText: "" })).rejects.toBeInstanceOf(Error);

      expect(attemptCount).toBe(1);
      // message.tokens reflects only the final attempt's fold...
      expect(processor.message.tokens.input).toBe(100);
      expect(processor.message.tokens.output).toBe(40);
      // ...while the billed total includes the retried attempt.
      expect(processor.usageTotals).toEqual({
        input: 100,
        output: 40,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      });
    });

test("accumulates tokens across multiple step-finish events", async () => {
      const model: Provider.Model = {
        id: "claude-3-5-sonnet-20241022",
        providerID: "anthropic",
        name: "Claude 3.5 Sonnet",
      };

      const processor = createProcessor({
        model,
        createStream: streamOf([
          {
            type: "step-finish",
            finishReason: "tool_use",
            usage: { inputTokens: 1000, outputTokens: 500 },
          },
          {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 2000, outputTokens: 800 },
          },
          { type: "finish" },
        ]),
      });

      await processor.process({ system: "", promptText: "" });

      expect(processor.message.cost).toBe(0);
      expect(processor.message.tokens.input).toBe(3000);
      expect(processor.message.tokens.output).toBe(1300);
    });
});
