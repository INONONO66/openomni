import { Provider, run as llmRun, type Run, type RunInput, type Sink } from "@openomni/llm";
import {
  Machine,
  type Message,
  type Model,
  type PlainObject,
  type PlainValue,
} from "@openomni/protocol";
import { Bus, newTraceId, currentExecutor, type Executor } from "@openomni/agent";
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
    const system = systemText(input);
    const answer = await llm({
      prompt: input.prompt,
      ...(system === "" ? {} : { system }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    return input.schema === undefined ? answer : conform(answer, input.schema);
  };
}

/** The sub-model's system text: the cell's own system text, then the schema instruction when a schema is given. */
function systemText(input: z.output<typeof Input>): string {
  const parts: string[] = [];
  if (input.system !== undefined) parts.push(input.system);
  if (input.schema !== undefined) parts.push(schemaInstruction(input.schema));
  return parts.join("\n\n");
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
  readonly providerOptions?: PlainObject;
}

/** Collects the assistant's text as the run streams; tool activity is inert on a toolless step. */
function textCapture(): { readonly sink: Sink; readonly text: () => string } {
  let answer = "";
  const sink: Sink = {
    onMessage: (message) => {
      if (message.info.role !== "assistant") return;
      answer = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    },
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  return { sink, text: () => answer };
}

/** The run fields a call may leave out; absent stays absent (exact optional properties). */
function optionalRunFields(
  call: ResolvedTextCall,
): Pick<RunInput, "system" | "transport" | "signal" | "maxTokens" | "providerOptions"> {
  return {
    ...(call.system === undefined ? {} : { system: call.system }),
    ...(call.model.transport === undefined ? {} : { transport: call.model.transport }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
    ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }),
  };
}

/** A stopped step yields the captured text; every other outcome is the failure it names. */
function textOutcome(outcome: Run.Outcome, text: string): { readonly text: string } {
  if (outcome.type === "stop") return { text };
  if (outcome.type === "error") throw outcome.error;
  if (outcome.type === "aborted") throw new DOMException("sub-model aborted", "AbortError");
  throw new Error("sub-model returned continue");
}

/** The executed value must be the `{ text }` record `textOutcome` produced; anything else is a broken executor. */
function executedText(value: PlainValue): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid sub-model result");
  }
  const text = value.text;
  if (typeof text !== "string") throw new Error("invalid sub-model result");
  return text;
}

/** One llm/text operation under the session's attempt authority; the admission re-checks the caller's signal. */
function admittedTextRun(
  call: ResolvedTextCall,
  resolved: Provider.Model,
  body: () => Promise<{ readonly text: string }>,
): ReturnType<Executor["run"]> {
  const executor = currentExecutor();
  const runAttempts = executor.runAttempts;
  if (runAttempts === undefined) throw new Error("sub-model requires session attempt authority");
  const intent = { provider: resolved.providerID, model: resolved.id };
  return executor.run({ kind: "llm", op: "text", intent, effect: {} }, (parent) =>
    runAttempts(parent, {
      prepare: async (attempt) => ({
        request: { op: "text", intent: { attempt, ...intent }, effect: {} },
        admit: async () => {
          call.signal?.throwIfAborted();
        },
        body,
      }),
    }),
  );
}

/** Shared resolved-model, credential, transport, and text-capture path for app-owned one-shot calls. */
export async function runResolvedText(call: ResolvedTextCall, io: LlmIo = {}): Promise<string> {
  const capture = textCapture();
  const ref: Model.Ref = { provider: call.model.provider, id: call.model.id };
  const resolved = await (io.resolveModel ?? Provider.resolveModel)(ref);
  const input: RunInput = {
    messages: call.messages,
    tools: [],
    toolChoice: "none",
    maxSteps: 1,
    model: resolved,
    auth: { type: "api", key: call.model.apiKey },
    authProvider: call.model.provider,
    ...optionalRunFields(call),
    trace: { traceId: newTraceId(), sessionId: call.sessionId, runId: crypto.randomUUID() },
    events: Bus,
  };
  const run = io.run ?? llmRun;
  const result = await admittedTextRun(call, resolved, async () =>
    textOutcome(await run(input, capture.sink), capture.text()),
  );
  if (result.terminal !== "executed") throw new Error(`sub-model refused: ${result.reason}`);
  return executedText(result.value);
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
