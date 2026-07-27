import { createHash } from "node:crypto";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import { Execution, LlmCall, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { BoundarySanitizer } from "./auth/boundary-sanitizer";
import { SecretRegistry, type SecretHandle } from "./auth/secret-registry";
import type { SDKMessage } from "./message";
import { toModelMessages } from "./message";
import { canonicalize } from "./model/catalog-cache";
import { Processor } from "./processor";
import { Provider } from "./provider";
import { getLanguage } from "./provider/sdk";

export interface LLMEnvironment {
  readonly reference: Execution.LLMEnvironmentV1;
  readonly credential: SecretHandle;
  readonly secrets: SecretRegistry;
  readonly sanitizer: BoundarySanitizer;
}

export interface RunInput {
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model: Provider.Model;
  environment: LLMEnvironment;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  toolChoice?: "auto" | "required" | "none";
  maxSteps?: number;
  providerOptions?: Record<string, unknown>;
  trace?: { traceId?: string; runId?: string };
}

type StreamEvent = { type: string; [key: string]: unknown };

export async function run(input: RunInput, sink: Sink): Promise<Run.Outcome> {
  const { messages, system = "", signal, model, environment } = input;
  assertEnvironment(model, environment);

  const abortController = signal ? null : new AbortController();
  const abortSignal = signal ?? abortController?.signal;
  if (!abortSignal) throw new Error("Failed to initialize abort signal");
  if (abortSignal.aborted) return { type: "aborted" };

  const sessionID = messages[0]?.info.sessionID || `session-${crypto.randomUUID()}`;
  const messageID = `msg-${crypto.randomUUID()}`;
  const parentID = messages[messages.length - 1]?.info.id || "";
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
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  const createStream: Processor.ProcessorOptions["createStream"] = async (streamInput) => {
    async function* adaptStream(): AsyncGenerator<StreamEvent> {
      const queue: StreamEvent[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      let failure: unknown;
      const notify = () => {
        wake?.();
        wake = undefined;
      };

      const producer = environment.secrets
        .withMaterialized(environment.credential, model.providerID, async (credential) => {
          const ai = await import("ai");
          const languageModel = getLanguage(model, credential);
          const normalizedMessages = toModelMessages(messages, model);
          const systemMessages: SDKMessage[] = streamInput.system
            ? [{ role: "system" as const, content: streamInput.system }]
            : [];
          const sdkTools: Record<string, unknown> = {};

          for (const spec of input.tools) {
            const toolExecutor = input.toolExecutor;
            if (!toolExecutor) {
              sdkTools[spec.name] = {
                type: "function" as const,
                description: spec.description,
                inputSchema: ai.jsonSchema(spec.inputSchema),
              };
              continue;
            }
            sdkTools[spec.name] = {
              type: "function" as const,
              description: spec.description,
              inputSchema: ai.jsonSchema(spec.inputSchema),
              execute: async (
                args: Record<string, unknown>,
                options?: { toolCallId?: string; abortSignal?: AbortSignal },
              ) => {
                try {
                  const sanitizedArgs = environment.sanitizer.sanitizeValue(
                    "provider-tool-callback",
                    args,
                  );
                  const call: Tool.Call = {
                    id: environment.sanitizer.sanitizeText(
                      "provider-tool-call-id",
                      options?.toolCallId ?? crypto.randomUUID(),
                    ),
                    tool: spec.name,
                    input:
                      typeof sanitizedArgs === "object" &&
                      sanitizedArgs !== null &&
                      !Array.isArray(sanitizedArgs)
                        ? (sanitizedArgs as Record<string, unknown>)
                        : {},
                  };
                  const result = await toolExecutor(call, {
                    signal: options?.abortSignal ?? abortSignal,
                  });
                  return environment.sanitizer.sanitizeValue("provider-tool-result", {
                    output: result?.output ?? "",
                    ...(result?.isError === true ? { isError: true } : {}),
                  });
                } catch (error) {
                  throw environment.sanitizer.sanitizeError("provider-tool-error", error);
                }
              },
            };
          }

          const streamResult = ai.streamText({
            model: languageModel,
            messages: [...systemMessages, ...normalizedMessages],
            tools: sdkTools,
            toolChoice: input.toolChoice,
            maxRetries: 0,
            stopWhen: ai.stepCountIs(input.maxSteps ?? 24),
            onError: ({ error }: { error: unknown }) => {
              const sanitized = environment.sanitizer.sanitizeError("provider-on-error", error);
              Bus.publish(Operational.Error, {
                traceId: input.trace?.traceId ?? crypto.randomUUID(),
                time: Date.now(),
                sessionId: sessionID,
                component: "llm.stream",
                msg: "streamText error",
                error: sanitized.message,
              });
            },
            abortSignal,
            ...(input.providerOptions === undefined
              ? {}
              : { providerOptions: input.providerOptions }),
          } as Parameters<typeof ai.streamText>[0]);

          for await (const rawChunk of streamResult.fullStream) {
            const sanitized = environment.sanitizer.sanitizeValue(
              "provider-stream-result",
              rawChunk,
            );
            if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) {
              throw new Error("Provider emitted an invalid stream event");
            }
            const event = sanitized as StreamEvent;
            if (typeof event.type !== "string")
              throw new Error("Provider stream event has no type");
            queue.push(
              event.type === "finish-step"
                ? { ...event, type: "step-finish" }
                : event.type === "start-step"
                  ? { ...event, type: "step-start" }
                  : event,
            );
            notify();
          }
        })
        .catch((error) => {
          failure = environment.sanitizer.sanitizeError("provider-stream-catch", error);
        })
        .finally(() => {
          finished = true;
          notify();
        });

      try {
        while (!finished || queue.length > 0) {
          const event = queue.shift();
          if (event) {
            yield event;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        await producer;
        if (failure !== undefined) throw failure;
      } finally {
        await producer;
      }
    }

    return { fullStream: adaptStream() };
  };

  const traceId = input.trace?.traceId ?? crypto.randomUUID();
  const provider = model.providerID;
  const processor = Processor.create({
    assistantMessage,
    sessionID,
    model,
    abort: abortSignal,
    sink,
    createStream,
    trace: {
      traceId,
      sessionId: sessionID,
      ...(input.trace?.runId !== undefined && { runId: input.trace.runId }),
      provider,
    },
  });

  Bus.publish(LlmCall.Started, {
    traceId,
    sessionId: sessionID,
    ...(input.trace?.runId !== undefined && { runId: input.trace.runId }),
    provider,
    model: model.id,
    messageCount: messages.length,
    toolCount: input.tools.length,
    time: Date.now(),
  });
  const startMs = Date.now();

  try {
    const result = await processor.process({
      messages: messages.map((m) => m.info),
      model,
      system,
    });
    const finalTokens = processor.message.tokens;
    Bus.publish(LlmCall.Completed, {
      traceId,
      sessionId: sessionID,
      ...(input.trace?.runId !== undefined && { runId: input.trace.runId }),
      provider,
      model: model.id,
      durationMs: Date.now() - startMs,
      inputTokens: finalTokens.input,
      outputTokens: finalTokens.output,
      reasoningTokens: finalTokens.reasoning,
      cacheReadTokens: finalTokens.cache.read,
      cacheWriteTokens: finalTokens.cache.write,
      finishReason: processor.message.finish ?? "unknown",
      time: Date.now(),
    });
    return result === "continue" || result === "compact" ? { type: result } : { type: "stop" };
  } catch (error) {
    if (abortSignal.aborted) return { type: "aborted" };
    const sanitized = environment.sanitizer.sanitizeError("provider-run-result", error);
    return {
      type: "error",
      error: { message: sanitized.message, name: sanitized.name, stack: sanitized.stack },
    };
  }
}

function assertProxyEndpoint(reference: Execution.LLMEnvironmentV1): void {
  const endpointRef = reference.credential.endpointRef;
  if (endpointRef === undefined || !endpointRef.startsWith("proxy:")) {
    throw new TypeError("Proxy credential reference is missing canonical endpoint provenance");
  }
  const baseURL = endpointRef.slice("proxy:".length);
  if (baseURL.length === 0) {
    throw new TypeError("Proxy credential reference is missing canonical endpoint provenance");
  }
  const expectedDigest = createHash("sha256").update(baseURL).digest("hex");
  if (
    reference.endpoint.kind !== "proxy" ||
    reference.endpoint.valueRef !== endpointRef ||
    reference.endpoint.endpointDigest !== expectedDigest
  ) {
    throw new TypeError("LLM environment endpoint does not match the proxy credential");
  }
}

function assertEnvironment(model: Provider.Model, environment: LLMEnvironment): void {
  if (!SecretRegistry.isSanitizerPair(environment.secrets, environment.sanitizer)) {
    throw new TypeError("Invalid SecretRegistry and BoundarySanitizer pair");
  }
  const reference = Execution.LLMEnvironmentV1.parse(environment.reference);
  const credential = environment.secrets.describe(environment.credential);
  if (canonicalize(reference.credential) !== canonicalize(credential)) {
    throw new TypeError("Credential handle does not match the LLM environment");
  }
  if (reference.credential.providerId !== model.providerID) {
    throw new TypeError("LLM environment provider does not match the selected model");
  }
  if (reference.credential.authType === "proxy") {
    assertProxyEndpoint(reference);
  }
  if (!model.api || reference.sdkPackage !== model.api.npm) {
    throw new TypeError("LLM environment SDK package does not match the selected model");
  }
  const { environmentDigest, ...base } = reference;
  const digest = Provider.environmentDigest(base);
  if (digest !== environmentDigest) throw new TypeError("LLM environment digest does not match");
  const modelDigest = Provider.modelDigest(model);
  if (modelDigest !== reference.modelDigest) {
    throw new TypeError("LLM environment model digest does not match the selected model");
  }
}
