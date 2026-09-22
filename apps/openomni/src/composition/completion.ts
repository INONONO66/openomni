import { Bus, executorContext, ForeignFailure, Interrupted, newTraceId, type ExecutionError } from "@openomni/agent";
import { Provider, run as llmRun, type RunInput, type Sink, type Run } from "@openomni/llm";
import type { Message, PlainObject } from "@openomni/protocol";
import { Effect } from "effect";
import type { LlmCall } from "../tools/completion";

export interface LlmIo {
  readonly run?: typeof llmRun;
  readonly resolveModel?: typeof Provider.resolveModel;
}
interface ResolvedModel {
  readonly provider: string;
  readonly id: string;
  readonly apiKey: string;
  readonly transport?: { readonly baseUrl?: string; readonly headers?: Record<string, string> };
}
interface ResolvedTextCall {
  readonly model: ResolvedModel;
  readonly messages: Message.WithParts[];
  readonly system?: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly providerOptions?: PlainObject;
}

function textCapture(): { readonly sink: Sink; readonly text: () => string } {
  let answer = "";
  return {
    sink: {
      onMessage: (message) => {
        if (message.info.role === "assistant")
          answer = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    },
    text: () => answer,
  };
}

function textOutcome(outcome: Run.Outcome, text: string): Effect.Effect<{ readonly text: string }, ExecutionError> {
  if (outcome.type === "stop") return Effect.succeed({ text });
  if (outcome.type === "error") return Effect.fail(outcome.error);
  if (outcome.type === "aborted") return Effect.fail(new Interrupted());
  return Effect.fail(new ForeignFailure({ operation: "completion", cause: "sub-model returned continue" }));
}

/** The app composes the native attempt; only the tool adapter at the gateway runs it. */
export function runResolvedText(call: ResolvedTextCall, io: LlmIo = {}): Effect.Effect<string, ExecutionError> {
  return Effect.gen(function* () {
    const capture = textCapture();
    const resolved = yield* (io.resolveModel ?? Provider.resolveModel)({ provider: call.model.provider, id: call.model.id })
      .pipe(Effect.mapError((error) => new ForeignFailure({ operation: "completion.resolve", cause: String(error) })));
    const input: RunInput = {
      messages: call.messages, tools: [], toolChoice: "none", maxSteps: 1, model: resolved,
      auth: { type: "api", key: call.model.apiKey }, authProvider: call.model.provider,
      ...(call.system === undefined ? {} : { system: call.system }),
      ...(call.model.transport === undefined ? {} : { transport: call.model.transport }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
      ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
      ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }),
      trace: { traceId: newTraceId(), sessionId: call.sessionId, runId: crypto.randomUUID() }, events: Bus,
    };
    const executor = yield* executorContext;
    const runAttempts = executor.runAttempts;
    if (runAttempts === undefined)
      return yield* new ForeignFailure({ operation: "completion", cause: "sub-model requires session attempt authority" });
    const intent = { provider: resolved.providerID, model: resolved.id };
    const result = yield* executor.run({ kind: "llm", op: "text", intent, effect: {} }, (parent) => runAttempts(parent, {
      prepare: (attempt) => Effect.succeed({
        request: { op: "text", intent: { attempt, ...intent }, effect: {} },
        admit: () => call.signal?.aborted ? Effect.fail(new Interrupted()) : Effect.void,
        body: () => (io.run ?? llmRun)(input, capture.sink).pipe(
          Effect.mapError((error): ExecutionError => error._tag === "LlmRunFailure" ? error : new ForeignFailure({ operation: "completion.run", cause: String(error) })),
          Effect.flatMap((outcome) => textOutcome(outcome, capture.text())),
        ),
      }),
    }));
    if (result.terminal === "interrupted") return yield* new Interrupted();
    if (result.terminal !== "executed")
      return yield* new ForeignFailure({ operation: "completion", cause: `sub-model refused: ${result.reason}` });
    const value = result.value;
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string")
      return yield* new ForeignFailure({ operation: "completion", cause: "invalid sub-model result" });
    return value.text;
  });
}

export function createCompletionPort(model: ResolvedModel, io: LlmIo = {}) {
  return (call: LlmCall): Effect.Effect<string, ExecutionError> => {
    const sessionId = "completion";
    const messageId = crypto.randomUUID();
    const target = call.model === undefined ? model : { ...model, id: call.model };
    return runResolvedText({
      model: target,
      messages: [{
        info: { id: messageId, sessionID: sessionId, role: "user", time: { created: Date.now() }, agent: "completion", model: { providerID: target.provider, modelID: target.id } },
        parts: [{ id: crypto.randomUUID(), sessionID: sessionId, messageID: messageId, type: "text", text: call.prompt }],
      }],
      sessionId,
      ...(call.system === undefined ? {} : { system: call.system }),
    }, io);
  };
}
