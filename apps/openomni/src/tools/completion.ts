import { Provider, run as llmRun, type RunInput, type Sink } from "@openomni/llm";
import { Machine, type Message, type Model } from "@openomni/protocol";
import { Bus, newTraceId, currentExecutor } from "@openomni/agent";
import { z } from "zod";
import { defineTool, ToolRefused } from "@openomni/agent";

/** What one sub-model call asks for: the prompt, and optionally a system text and model id. */
interface LlmCall {
  readonly prompt: string;
  readonly system?: string;
  /** A model id on the port's configured provider; the port owns that provider's credential. */
  readonly model?: string;
}

/**
 * A one-shot sub-model call, without knowing how the host is composed: a
 * prompt in, the model's text out. Stateless by contract — each call is a
 * fresh completion, so the port carries no history.
 */
export type LlmPort = (call: LlmCall) => Promise<string>;

/** The per-cell call budget: how many sub-model calls one executor may serve. */
const MAX_COMPLETION_CALLS = 32;

/** The cell's `completion(prompt, {model?, system?, schema?})`, one prompt per call. */
const Input = Machine.CompletionRequest;

const COMPLETION_TOOL_NAME = "completion";

function schemaInstruction(schema: NonNullable<Machine.CompletionRequest["schema"]>): string {
  return `Answer with one JSON value that satisfies this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`;
}

/** Strip a Markdown code fence a model may wrap its JSON in; the content is what gets validated. */
function unfence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/** The answer as canonical JSON text once it satisfies the schema; otherwise a refusal the cell can catch. */
function conform(answer: string, schema: NonNullable<Machine.CompletionRequest["schema"]>): string {
  const validator = z.fromJSONSchema(schema);
  let checked: ReturnType<typeof validator.safeParse>;
  try {
    checked = validator.safeParse(JSON.parse(unfence(answer)));
  } catch {
    throw new ToolRefused(COMPLETION_TOOL_NAME, `sub-model answer is not JSON: ${answer}`);
  }
  if (!checked.success)
    throw new ToolRefused(
      COMPLETION_TOOL_NAME,
      `sub-model answer does not satisfy the schema: ${checked.error.message}`,
    );
  return JSON.stringify(checked.data);
}

function executeCompletion(llm: LlmPort | undefined) {
  let calls = 0;
  return async (input: z.output<typeof Input>): Promise<string> => {
    if (llm === undefined)
      throw new ToolRefused(COMPLETION_TOOL_NAME, "sub-model port is not composed");
    if (calls >= MAX_COMPLETION_CALLS) {
      throw new ToolRefused(
        COMPLETION_TOOL_NAME,
        `the per-cell budget of ${MAX_COMPLETION_CALLS} sub-model calls is spent`,
      );
    }
    calls += 1;
    const system = [
      input.system,
      input.schema === undefined ? undefined : schemaInstruction(input.schema),
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n\n");
    const answer = await llm({
      prompt: input.prompt,
      ...(system === "" ? {} : { system }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    return input.schema === undefined ? answer : conform(answer, input.schema);
  };
}

/** Cell-only: batching is the cell's `parallel()`, so the input is one prompt. */
export function createCompletionTool(llm: LlmPort | undefined) {
  return defineTool({
    name: COMPLETION_TOOL_NAME,
    category: "execution",
    description:
      "Ask a sub-model one one-shot, stateless question and return its text. Options: model (an id on the configured provider), system, schema (a JSON Schema the answer must satisfy; the validated JSON text is returned).",
    input: Input,
    output: z.string(),
    visibility: { model: [], cell: ["resident", "worker"] },
    execute: executeCompletion(llm),
    render: (_args, value) => value,
  });
}

/**
 * The same substitution seam ChatAgentConfig["llm"] gives the Resident and
 * the worker loop: absent fields use the real provider I/O. Boot passes its
 * `options.llm` through, so a composition booted on a fake model never lets
 * this one port slip out to the network.
 */
export interface LlmIo {
  readonly run?: typeof llmRun;
  readonly resolveModel?: (model: Model.Ref) => Promise<Provider.Model>;
}

/**
 * The completion tool's one-shot sub-model call: a single user message, no tools,
 * one step, its own synthesized trace — a nested run must never borrow the
 * turn's run identity. Auth is the configured key, exactly as the Resident
 * and the worker loop authenticate.
 */
interface ResolvedModel {
  readonly provider: string;
  readonly id: string;
  readonly apiKey: string;
  /** Operator transport overrides in the llm package's shape (see `modelTransport`). */
  readonly transport?: { readonly baseUrl?: string; readonly headers?: Record<string, string> };
}

interface ResolvedTextCall {
  readonly model: ResolvedModel;
  readonly messages: Message.WithParts[];
  readonly system?: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly providerOptions?: Record<string, unknown>;
}

/** Shared resolved-model, credential, transport, and text-capture path for app-owned one-shot calls. */
export async function runResolvedText(call: ResolvedTextCall, io: LlmIo = {}): Promise<string> {
  let answer = "";
  const sink: Sink = {
    onMessage: (message) => {
      if (message.info.role !== "assistant") return;
      answer = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
    },
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  const ref: Model.Ref = { provider: call.model.provider, id: call.model.id };
  const resolved = await (io.resolveModel ?? Provider.resolveModel)(ref);
  const input: RunInput = {
    messages: call.messages,
    ...(call.system === undefined ? {} : { system: call.system }),
    tools: [],
    toolChoice: "none",
    maxSteps: 1,
    model: resolved,
    auth: { type: "api", key: call.model.apiKey },
    authProvider: call.model.provider,
    ...(call.model.transport === undefined ? {} : { transport: call.model.transport }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
    ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }),
    trace: { traceId: newTraceId(), sessionId: call.sessionId, runId: crypto.randomUUID() },
    events: Bus,
  };
  const invoke = async () => {
    const outcome = await (io.run ?? llmRun)(input, sink);
    if (outcome.type === "stop") return { text: answer };
    if (outcome.type === "error") throw outcome.error;
    if (outcome.type === "aborted") throw new DOMException("sub-model aborted", "AbortError");
    throw new Error("sub-model returned continue");
  };
  const executor = currentExecutor();
  const runAttempts = executor.runAttempts;
  if (runAttempts === undefined) throw new Error("sub-model requires session attempt authority");
  const result = await executor.run(
    {
      kind: "llm",
      op: "text",
      intent: { provider: resolved.providerID, model: resolved.id },
      effect: {},
    },
    (parent) =>
      runAttempts(parent, {
        prepare: async (attempt) => ({
          request: {
            op: "text",
            intent: { attempt, provider: resolved.providerID, model: resolved.id },
            effect: {},
          },
          admit: async () => {
            call.signal?.throwIfAborted();
          },
          body: invoke,
        }),
      }),
  );
  if (result.terminal !== "executed") throw new Error(`sub-model refused: ${result.reason}`);
  const value = result.value;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.text !== "string"
  )
    throw new Error("invalid sub-model result");
  return value.text;
}

export function createCompletionPort(model: ResolvedModel, io: LlmIo = {}): LlmPort {
  return async (call) => {
    const sessionId = "completion";
    const messageId = crypto.randomUUID();
    // A requested model id stays on the configured provider: that is the only credential this port holds.
    const target = call.model === undefined ? model : { ...model, id: call.model };
    const request: Message.WithParts = {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "completion",
        model: { providerID: target.provider, modelID: target.id },
      },
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text: call.prompt,
        },
      ],
    };
    return runResolvedText(
      {
        model: target,
        messages: [request],
        sessionId,
        ...(call.system === undefined ? {} : { system: call.system }),
      },
      io,
    );
  };
}
