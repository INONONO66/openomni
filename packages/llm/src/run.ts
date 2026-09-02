import type { BusEvent, Message, Tool } from "@openomni/protocol";
import { LlmCall, Operational } from "@openomni/protocol";
import { z } from "zod";
import type { Sink } from "./sink";
import type { SDKMessage } from "./message";
import { Processor } from "./processor";
import { toModelMessages } from "./message";
import type { Provider } from "./provider";
import { ProviderTransform } from "./provider/transform";
import { getLanguage, type Transport } from "./provider/sdk";
import { Auth } from "./auth/storage";
import { coerceApiError, NamedError } from "./error";
import { Retry } from "./retry";

/**
 * Input for the run() function.
 *
 * The function resolves auth credentials for the configured model
 * and calls the real provider SDK.
 */
export interface RunInput {
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model: Provider.Model;
  auth?: Auth.Info;
  /**
   * Operator-supplied endpoint and headers for this call. Resolved by the
   * host from its own config surface and handed down like `auth`, so this
   * package reads no environment of its own. Absent keeps the catalog's URL
   * and the default client identity.
   */
  transport?: Transport;
  allowAuthFallback?: boolean;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  toolChoice?: "auto" | "required" | "none";
  /** Maximum generated tokens for this call; absent leaves the provider default. */
  maxTokens?: number;
  maxSteps?: number;
  /**
   * Transport retries performed inside this single run call. Absent keeps the
   * bounded standalone default; orchestrators that own retry attempts set 0.
   */
  maxRetryAttempts?: number;
  /**
   * Step-boundary yield: stop the step loop once the last finished step's
   * input tokens (the ai SDK's cache-inclusive prompt total) reach this.
   * The loop ends gracefully at a step boundary — tool pairs complete, the
   * message finishes with the model's own finishReason — so the caller can
   * compact history at its deterministic seam and re-enter. Absent = never.
   */
  yieldAtInputTokens?: number;
  /**
   * Step-boundary steering yield (#751): stop the step loop at the next step
   * boundary while this host-injected check returns true — e.g. a mid-turn
   * injection is pending for the run. Evaluated beside the step cap and the
   * window yield, so the loop still ends gracefully: tool pairs complete and
   * the message finishes with the model's own finishReason. Absent = never.
   */
  shouldYield?: () => boolean;
  providerOptions?: Record<string, unknown>;
  /**
   * The run this call belongs to. Required, and not defaulted: a model round
   * trip that cannot name its run and session produces an assistant message
   * detached from the conversation it is part of, and telemetry that
   * correlates to nothing.
   */
  trace: { traceId: string; sessionId: string; runId: string };
  /**
   * Where observation goes. See `Processor.ProcessorOptions.events` — the port exists so
   * `llm` reports what it did without reaching for a process-wide singleton.
   */
  events: BusEvent.Sink;
}

export interface RunDependencies {
  /** Overrides provider stream creation for an isolated caller or test harness. */
  createStream?: Processor.ProcessorOptions["createStream"];
}

/**
 * #500 C1: the loop-run result vocabulary, moved here from protocol — this
 * package's `run()` is the sole producer and the consumers (agent core) all
 * depend on llm already. The `Run.Outcome` name is kept: llm hosted no `Run`
 * namespace, so there is no collision (`run` the function and `Run` the
 * namespace are distinct identifiers).
 */
export namespace Run {
  const FailureUsage = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  });

  /**
   * The typed failure crossing from the provider-owning package to Agent.
   * `cause` remains Error's native cause chain; machine-consumed facts live
   * in data so consumers never have to recover them from prose.
   */
  export const FailureError = NamedError.create(
    "LlmRunFailure",
    z.object({
      message: z.string(),
      providerErrorName: z.string().optional(),
      retryAfterMs: z.number().nonnegative().optional(),
      usage: FailureUsage,
      aborted: z.boolean(),
      contextOverflow: z.boolean(),
    }),
  );
  export type Failure = InstanceType<typeof FailureError>;

  const LegacyError = z.object({
    message: z.string(),
    name: z.string().optional(),
    stack: z.string().optional(),
  });

  export const Outcome = z.discriminatedUnion("type", [
    z.object({ type: z.literal("stop") }),
    z.object({ type: z.literal("continue") }),
    z.object({
      type: z.literal("aborted"),
      error: z.instanceof(FailureError).optional(),
    }),
    z.object({
      type: z.literal("error"),
      error: z.union([z.instanceof(FailureError), LegacyError]),
    }),
  ]);
  export type Outcome = z.infer<typeof Outcome>;
}

/**
 * Assign each tool spec its wire name — the provider-pattern-safe key it takes
 * in the `tools` object crossing to the SDK — and the reverse map back to the
 * internal dotted name.
 *
 * The native catalog (`message.send`, `engagement.open`, …) is collision-free
 * under plain `.`→`_`, but MCP tool names are `${server}.${name}` with
 * arbitrary segments, so two distinct originals can sanitize to the same key.
 * A silent overwrite of one tool's `execute` closure by another is a
 * correctness bug, so a taken key is disambiguated with a deterministic
 * `_2`/`_3`/… suffix (truncated to keep the 128-char bound). The reverse map
 * lets the transcript record the dotted internal name instead of the wire name.
 */
function assignWireToolNames(tools: Tool.Spec[]): {
  wireNames: string[];
  originalByWire: Map<string, string>;
} {
  const wireNames: string[] = [];
  const originalByWire = new Map<string, string>();
  for (const spec of tools) {
    const base = ProviderTransform.sanitizeToolName(spec.name);
    let wire = base;
    let suffix = 2;
    while (originalByWire.has(wire)) {
      const tail = `_${suffix++}`;
      wire = base.slice(0, 128 - tail.length) + tail;
    }
    originalByWire.set(wire, spec.name);
    wireNames.push(wire);
  }
  return { wireNames, originalByWire };
}

export async function run(
  input: RunInput,
  sink: Sink,
  dependencies: RunDependencies = {},
): Promise<Run.Outcome> {
  const { messages, system = "", signal, model } = input;

  const abortSignal = signal ?? new AbortController().signal;
  if (abortSignal.aborted) {
    return { type: "aborted" };
  }

  const { traceId, sessionId: sessionID, runId } = input.trace;
  if (traceId.length === 0 || sessionID.length === 0 || runId.length === 0) {
    throw new Error("llm run requires a non-empty traceId, sessionId, and runId");
  }
  const messageID = `msg-${crypto.randomUUID()}`;
  const parentID = messages[messages.length - 1]?.info.id || "";

  // The tool set is fixed across retries, so the wire-name assignment (and its
  // reverse map for transcript fidelity) is computed once here and captured by
  // createStream. The reverse map keeps the recorded ToolPart.tool dotted even
  // though the stream reports the wire name the provider echoed back.
  const { wireNames, originalByWire } = assignWireToolNames(input.tools);

  const assistantMessage: Message.AssistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: model.id,
    providerID: model.providerID,
    agent: "default",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  const createStream: Processor.ProcessorOptions["createStream"] = async (streamInput) => {
    const ai = await import("ai");
    const auth =
      input.auth ??
      (input.allowAuthFallback === false ? undefined : await Auth.get(model.providerID));
    if (!auth) {
      throw new Error(
        `No authentication found for provider: ${model.providerID}. Configure provider credentials or use a proxy auth provider first.`,
      );
    }

    const languageModel = getLanguage(model, auth, input.transport);

    const normalizedMessages = toModelMessages(messages, model);

    // #532 cache policy: breakpoints on the last tool definition and the
    // system message (the latest-user breakpoint is placed inside
    // toModelMessages). Namespaced under `anthropic`, absent for other providers.
    const cacheOptions = ProviderTransform.anthropicCacheOptions(model);
    const systemMessages: SDKMessage[] = streamInput.system
      ? [
          {
            role: "system" as const,
            content: streamInput.system,
            ...(cacheOptions && { providerOptions: cacheOptions }),
          },
        ]
      : [];

    // Tools are keyed by their wire name (provider-pattern-safe), but the
    // execute closure sets `tool: spec.name` (internal dotted) so execution
    // and policy always see the dotted vocabulary. The SDK dispatches execute
    // by the same key it advertised, so the wire→dotted reverse is free here.
    const sdkTools: Record<string, unknown> = {};
    input.tools.forEach((spec, index) => {
      const wireName = wireNames[index] as string;
      const executor = input.toolExecutor;
      sdkTools[wireName] = {
        type: "function" as const,
        description: spec.description,
        inputSchema: ai.jsonSchema(spec.inputSchema),
        ...(executor && {
          execute: async (
            args: Record<string, unknown>,
            options?: { toolCallId?: string; abortSignal?: AbortSignal },
          ) => {
            // The SDK always supplies toolCallId; a minted id would never
            // correlate with the stream's tool part, so refuse instead.
            if (options?.toolCallId === undefined) {
              throw new Error("tool execute called without toolCallId");
            }
            const call: Tool.Call = {
              id: options.toolCallId,
              tool: spec.name,
              input: args,
            };
            const result = await executor(call, {
              signal: options?.abortSignal ?? abortSignal,
            });
            return {
              output: result.output,
              ...(result.isError === true && { isError: true }),
            };
          },
        }),
      };
    });
    const lastToolName = wireNames[wireNames.length - 1];
    if (cacheOptions && lastToolName !== undefined) {
      (sdkTools[lastToolName] as Record<string, unknown>).providerOptions = cacheOptions;
    }

    const shouldYield = input.shouldYield;
    const streamArgs = {
      model: languageModel,
      messages: [...systemMessages, ...normalizedMessages],
      tools: sdkTools,
      toolChoice: input.toolChoice,
      ...(input.maxTokens === undefined ? {} : { maxOutputTokens: input.maxTokens }),
      maxRetries: 0,
      stopWhen: [
        ai.stepCountIs(input.maxSteps ?? 24),
        ...(input.yieldAtInputTokens === undefined
          ? []
          : [
              ({ steps }: { steps: ReadonlyArray<{ usage?: { inputTokens?: number } }> }) =>
                (steps[steps.length - 1]?.usage?.inputTokens ?? 0) >=
                (input.yieldAtInputTokens as number),
            ]),
        ...(shouldYield === undefined ? [] : [() => shouldYield()]),
      ],
      onError: ({ error }: { error: unknown }) => {
        input.events.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          sessionId: sessionID,
          component: "llm.stream",
          msg: "streamText error",
          error: String(error),
        });
      },
      abortSignal: abortSignal,
      // A nested streamText key, never a top-level spread: the AI SDK reads
      // provider namespaces ({anthropic: {thinking: ...}}) from
      // `providerOptions`, so spreading dropped them silently — and let
      // config keys clobber wired args (abortSignal, maxRetries, tools).
      ...(input.providerOptions !== undefined && { providerOptions: input.providerOptions }),
    };
    const streamResult = ai.streamText(streamArgs as Parameters<typeof ai.streamText>[0]);

    // The ai-sdk v6 fullStream already emits text-start/text-delta/text-end
    // and reasoning-start/delta/end; only the step markers use different
    // names internally. Synthesizing text boundaries here (the old ai-v4
    // shim) duplicated the real v6 events and left an empty orphan text part
    // per block.
    async function* adaptStream(): AsyncGenerator<{
      type: string;
      [key: string]: unknown;
    }> {
      for await (const chunk of streamResult.fullStream) {
        const event = chunk as { type: string; [key: string]: unknown };

        if (event.type === "finish-step") {
          yield { ...event, type: "step-finish" };
        } else if (event.type === "start-step") {
          yield { ...event, type: "step-start" };
        } else {
          yield event;
        }
      }
    }

    return { fullStream: adaptStream() };
  };
  const provider = model.providerID;
  const modelId = model.id;

  const processor = Processor.create({
    // Call-local injection keeps test and embedding harnesses isolated from
    // Bun's process-wide module mocks without changing production behavior.
    createStream: dependencies.createStream ?? createStream,
    events: input.events,
    assistantMessage,
    sessionID,
    model,
    abort: abortSignal,
    sink,
    toolNames: originalByWire,
    maxRetryAttempts: input.maxRetryAttempts,
    trace: {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
    },
  });

  input.events.publish(LlmCall.Events.Started, {
    traceId,
    sessionId: sessionID,
    runId: input.trace.runId,
    provider,
    model: modelId,
    messageCount: messages.length,
    toolCount: input.tools.length,
    time: Date.now(),
  });

  const startMs = Date.now();

  try {
    await processor.process({ system });

    const durationMs = Date.now() - startMs;
    // Billed usage across every attempt: retried attempts' tokens were billed
    // too; message.tokens holds only the final attempt's fold.
    const finalTokens = processor.usageTotals;
    const finishReason = processor.message.finish ?? "unknown";

    input.events.publish(LlmCall.Events.Completed, {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
      model: modelId,
      durationMs,
      inputTokens: finalTokens.input,
      outputTokens: finalTokens.output,
      reasoningTokens: finalTokens.reasoning,
      cacheReadTokens: finalTokens.cache.read,
      cacheWriteTokens: finalTokens.cache.write,
      finishReason,
      time: Date.now(),
    });

    return { type: "stop" };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const apiError = coerceApiError(err);
    const source = apiError ?? err;
    const sourceFacts = errorFacts(source);
    const aborted = abortSignal.aborted || sourceFacts.aborted === true;
    const usage = processor.usageTotals;
    const retryAfterMs = Retry.retryAfterMs(source);
    const failure = new Run.FailureError(
      {
        message: err.message,
        providerErrorName: err.name,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          reasoningTokens: usage.reasoning,
          cacheReadTokens: usage.cache.read,
          cacheWriteTokens: usage.cache.write,
        },
        aborted,
        contextOverflow: sourceFacts.contextOverflow === true,
      },
      { cause: source },
    );
    if (err.stack !== undefined) failure.stack = err.stack;

    input.events.publish(LlmCall.Events.Failed, {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
      model: modelId,
      durationMs: Date.now() - startMs,
      error: err.message,
      aborted,
      time: Date.now(),
    });

    if (aborted) {
      return { type: "aborted", error: failure };
    }

    return { type: "error", error: failure };
  }
}

function errorFacts(error: unknown): { aborted?: boolean; contextOverflow?: boolean } {
  if (typeof error !== "object" || error === null) return {};
  if ("data" in error && typeof error.data === "object" && error.data !== null) {
    const data = error.data as Record<string, unknown>;
    return {
      ...(typeof data.aborted === "boolean" ? { aborted: data.aborted } : {}),
      ...(typeof data.contextOverflow === "boolean"
        ? { contextOverflow: data.contextOverflow }
        : {}),
    };
  }
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.aborted === "boolean" ? { aborted: record.aborted } : {}),
    ...(typeof record.contextOverflow === "boolean"
      ? { contextOverflow: record.contextOverflow }
      : {}),
  };
}
