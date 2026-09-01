import type { Message, Transcript } from "@openomni/protocol";
import type { Sink } from "../sink";
import { stringifyToolOutput } from "../message";
import { TokenTracker } from "../token";

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export type StreamEventContext = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly attemptId: string;
  readonly sink: Sink;
  /**
   * Records one transcript fact: folds it into the processor's attempt state
   * (loud-throw on rejection — a bad fact order is a recording defect) and
   * emits the part-boundary snapshot when the fact is a boundary.
   */
  readonly record: (fact: Transcript.Fact) => void;
  /** Debug note for normalized-away provider anomalies (#532-6). */
  readonly note: (msg: string, data?: Record<string, unknown>) => void;
  /**
   * Wire tool name → internal dotted name. The provider echoes the sanitized
   * wire name on stream events; this restores the dotted internal name on the
   * recorded part so the transcript keeps the native vocabulary. Absent =
   * record the name verbatim.
   */
  readonly toolNames?: ReadonlyMap<string, string>;
};

function resolveToolName(wireName: string, context: StreamEventContext): string {
  return context.toolNames?.get(wireName) ?? wireName;
}

type OpenBlock = {
  partId: string;
  text: string;
  signature?: string;
};

export type StreamEventState = {
  currentText?: OpenBlock;
  reasoning: Map<string, OpenBlock>;
  pendingTools: Map<string, string>;
  usage: Transcript.Usage;
  finishReason?: string;
};

export function createStreamEventState(): StreamEventState {
  return {
    reasoning: new Map(),
    pendingTools: new Map(),
    usage: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/**
 * Provider finish reason → transcript finish vocabulary, mapped exactly
 * (#532-7): length and content-filter/error finishes are never rewritten to
 * "stop". The transcript vocabulary has no content-filter value, so a
 * filtered turn closes as "error" — abnormal stays abnormal. The step-finish
 * part stores the ai-unified finishReason (e.g. "tool-calls"), not the raw
 * provider string — the agent's yield detector reads exactly that vocabulary.
 */
export function mapFinishReason(reason: string | undefined): Transcript.FinishReason {
  switch (reason) {
    case "length":
    case "max_tokens":
      return "length";
    case "error":
    case "content-filter":
    case "content_filter":
      return "error";
    default:
      // stop, end_turn, tool-calls, tool_use, other, unknown, absent.
      return "stop";
  }
}

export function handleStreamEvent(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  for (const normalized of normalizeEvent(event, state, context)) {
    applyStreamEvent(normalized, state, context);
  }
}

/**
 * #532-6 malformed-sequence normalization: rewrites impossible provider
 * sequences into legal ones before any fact is recorded. A delta for an
 * unopened block opens it; a duplicate end (or start) is dropped with a
 * debug note. This is deliberately a small input rewrite, not a layer —
 * everything downstream sees only well-formed block sequences.
 */
function normalizeEvent(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): StreamEvent[] {
  switch (event.type) {
    case "text-start": {
      if (state.currentText === undefined) return [event];
      context.note("stream.normalized", { anomaly: "text-start while a text block is open" });
      return [{ type: "text-end" }, event];
    }
    case "text-delta": {
      if (state.currentText !== undefined) return [event];
      context.note("stream.normalized", { anomaly: "text-delta for an unopened block" });
      return [{ type: "text-start", providerMetadata: event.providerMetadata }, event];
    }
    case "text-end": {
      if (state.currentText !== undefined) return [event];
      context.note("stream.normalized", { anomaly: "duplicate text-end ignored" });
      return [];
    }
    case "reasoning-start": {
      if (!state.reasoning.has(String(event.id))) return [event];
      context.note("stream.normalized", { anomaly: "duplicate reasoning-start ignored" });
      return [];
    }
    case "reasoning-delta": {
      if (state.reasoning.has(String(event.id))) return [event];
      context.note("stream.normalized", { anomaly: "reasoning-delta for an unopened block" });
      return [{ type: "reasoning-start", id: event.id }, event];
    }
    case "reasoning-end": {
      if (state.reasoning.has(String(event.id))) return [event];
      context.note("stream.normalized", { anomaly: "duplicate reasoning-end ignored" });
      return [];
    }
    default:
      return [event];
  }
}

function applyStreamEvent(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  switch (event.type) {
    case "text-start": {
      startText(event, state, context);
      break;
    }
    case "text-delta": {
      // Per-token cost is O(1): the delta only grows an internal buffer.
      if (state.currentText) {
        state.currentText.text += String(event.text || "");
      }
      break;
    }
    case "text-end": {
      finishText(state, context);
      break;
    }
    case "reasoning-start": {
      startReasoning(event, state, context);
      break;
    }
    case "reasoning-delta": {
      appendReasoning(event, state);
      break;
    }
    case "reasoning-end": {
      finishReasoning(event, state, context);
      break;
    }
    case "tool-call": {
      handleToolCall(event, state, context);
      break;
    }
    case "tool-result": {
      handleToolResult(event, state, context);
      break;
    }
    case "tool-error": {
      handleToolResult({ ...event, type: "tool-result", isError: true }, state, context);
      break;
    }
    case "step-start": {
      appendPart(
        {
          id: crypto.randomUUID(),
          sessionID: context.sessionID,
          messageID: context.messageID,
          type: "step-start",
        },
        context,
      );
      break;
    }
    case "step-finish": {
      handleStepFinish(event, state, context);
      break;
    }
    case "finish": {
      break;
    }
    case "error": {
      throw event.error;
    }
    default:
  }
}

function appendPart(part: Message.Part, context: StreamEventContext): void {
  context.record({
    type: "part.appended",
    attemptId: context.attemptId,
    messageId: context.messageID,
    part,
  });
}

function advancePart(
  partId: string,
  transition: Transcript.PartTransition,
  context: StreamEventContext,
): void {
  context.record({
    type: "part.advanced",
    attemptId: context.attemptId,
    messageId: context.messageID,
    partId,
    transition,
  });
}

function startText(event: StreamEvent, state: StreamEventState, context: StreamEventContext): void {
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: "text",
    text: "",
    time: { start: Date.now() },
    metadata: (event.providerMetadata as Record<string, unknown>) || {},
  };
  state.currentText = { partId: part.id, text: "" };
  appendPart(part, context);
}

function finishText(state: StreamEventState, context: StreamEventContext): void {
  const open = state.currentText;
  if (open === undefined) return;
  state.currentText = undefined;
  advancePart(
    open.partId,
    { to: "completed", at: Date.now(), output: open.text.trimEnd() },
    context,
  );
}

function startReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const part: Message.ReasoningPart = {
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: "reasoning",
    text: "",
    time: { start: Date.now(), end: undefined },
    metadata: (event.providerMetadata as Record<string, unknown>) || {},
  };
  state.reasoning.set(String(event.id), { partId: part.id, text: "" });
  appendPart(part, context);
}

function appendReasoning(event: StreamEvent, state: StreamEventState): void {
  const open = state.reasoning.get(String(event.id));
  if (open === undefined) return;
  open.text += String(event.text || "");
  const signature = extractSignature(event.providerMetadata);
  if (signature !== undefined) open.signature = signature;
}

function finishReasoning(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const reasoningId = String(event.id);
  const open = state.reasoning.get(reasoningId);
  if (open === undefined) return;
  state.reasoning.delete(reasoningId);
  const signature = extractSignature(event.providerMetadata) ?? open.signature;
  advancePart(
    open.partId,
    {
      to: "completed",
      at: Date.now(),
      output: open.text.trimEnd(),
      ...(signature !== undefined ? { signature } : {}),
    },
    context,
  );
}

/**
 * The provider reasoning signature rides providerMetadata (Anthropic emits it
 * as a trailing empty reasoning-delta with {anthropic:{signature}}). Scan the
 * namespaces so the capture is provider-agnostic.
 */
function extractSignature(providerMetadata: unknown): string | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) return undefined;
  for (const value of Object.values(providerMetadata)) {
    if (typeof value !== "object" || value === null) continue;
    const signature = (value as Record<string, unknown>).signature;
    if (typeof signature === "string") return signature;
  }
  return undefined;
}

function handleToolCall(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  // ai v6 tool-call chunks carry `input`; the v4 `args` leg fed only tests.
  const input = (event.input as Record<string, unknown>) || {};
  const callID = String(event.toolCallId);
  const part: Message.ToolPart = {
    id: crypto.randomUUID(),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: "tool",
    callID,
    tool: resolveToolName(String(event.toolName), context),
    state: { status: "pending", input },
  };
  appendPart(part, context);
  // The AI SDK executes the tool between tool-call and tool-result, so the
  // call event is the execution start: advance to running here so the result
  // can report a real duration.
  advancePart(part.id, { to: "running", at: Date.now() }, context);
  state.pendingTools.set(callID, part.id);
  context.sink.onToolCall({ id: callID, tool: part.tool, input });
}

function handleToolResult(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const toolCallId = String(event.toolCallId);
  const outputPayload = normalizeOutputPayload(event);
  const isError = event.isError === true || outputPayload.isError;
  const partId = state.pendingTools.get(toolCallId);

  if (partId === undefined) {
    // #532-6: a result for a call that never happened. Synthesize an error
    // part so the anomaly is recorded; no Tool.Call/Tool.Result is emitted
    // because no call exists to correlate with.
    context.note("stream.normalized", {
      anomaly: "tool-result for unknown call",
      toolCallId,
    });
    const synthetic: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "tool",
      callID: toolCallId,
      tool:
        event.toolName !== undefined ? resolveToolName(String(event.toolName), context) : "unknown",
      state: { status: "pending", input: {} },
    };
    const at = Date.now();
    appendPart(synthetic, context);
    advancePart(synthetic.id, { to: "running", at }, context);
    advancePart(
      synthetic.id,
      { to: "error", at, error: `tool result for unknown call: ${outputPayload.output}` },
      context,
    );
    return;
  }

  state.pendingTools.delete(toolCallId);
  advancePart(
    partId,
    isError
      ? { to: "error", at: Date.now(), error: outputPayload.output }
      : {
          to: "completed",
          at: Date.now(),
          output: outputPayload.output,
          ...(event.toolName !== undefined
            ? { title: resolveToolName(String(event.toolName), context) }
            : {}),
        },
    context,
  );
  context.sink.onToolResult({
    id: crypto.randomUUID(),
    toolCallId,
    output: outputPayload.output,
    ...(isError && { isError: true }),
  });
}

function handleStepFinish(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const finishReason = String(event.finishReason || "end_turn");
  const usage = TokenTracker.extractUsage({
    usage: event.usage,
    providerMetadata: event.providerMetadata,
  });

  state.finishReason = finishReason;
  state.usage = {
    input: state.usage.input + usage.inputTokens,
    output: state.usage.output + usage.outputTokens,
    reasoning: state.usage.reasoning + (usage.reasoningTokens ?? 0),
    cache: {
      read: state.usage.cache.read + (usage.cacheReadTokens ?? 0),
      write: state.usage.cache.write + (usage.cacheWriteTokens ?? 0),
    },
  };

  // #532-7: a length-truncated step cannot have completed its tool calls —
  // fail every non-terminal tool part now, no salvage.
  if (mapFinishReason(finishReason) === "length") {
    const at = Date.now();
    for (const [callID, partId] of state.pendingTools) {
      advancePart(
        partId,
        { to: "error", at, error: "truncated output: tool call incomplete" },
        context,
      );
      context.sink.onToolResult({
        id: crypto.randomUUID(),
        toolCallId: callID,
        output: "truncated output: tool call incomplete",
        isError: true,
      });
    }
    state.pendingTools.clear();
  }

  appendPart(
    {
      id: crypto.randomUUID(),
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "step-finish",
      reason: finishReason,
      // Not computed: the protocol part schema requires the field, but llm
      // has no pricing source wired — an explicit 0 is the honest value, not
      // a half-implemented estimate.
      cost: 0,
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens ?? 0,
        cache: {
          read: usage.cacheReadTokens ?? 0,
          write: usage.cacheWriteTokens ?? 0,
        },
      },
    },
    context,
  );
}

function normalizeOutputPayload(event: StreamEvent): { output: string; isError: boolean } {
  const raw = event.output;
  if (typeof raw === "object" && raw !== null && "output" in raw) {
    const payload = raw as { output?: unknown; isError?: unknown };
    return {
      output: String(payload.output ?? ""),
      isError: payload.isError === true,
    };
  }
  const value = raw ?? event.error ?? event.message ?? "";
  return {
    output: stringifyToolOutput(value),
    isError: false,
  };
}

/**
 * Closes everything the attempt left open, as facts, before the attempt's
 * message.finished. Text and reasoning close as completed with whatever
 * partial output the buffer holds — "interrupted" is tool-only vocabulary in
 * T1. Tools follow the #543 grace-settle semantics: after the abort grace
 * expires they advance to interrupted (the tool may have produced a real
 * side effect we can no longer observe); on every other unsettled exit
 * (clean stream end after stepCountIs, retryable failure, non-retryable
 * error) they advance to error.
 */
export function settleAttempt(
  state: StreamEventState,
  context: StreamEventContext,
  options: { aborted: boolean },
): void {
  finishText(state, context);
  for (const reasoningId of [...state.reasoning.keys()]) {
    finishReasoning({ type: "reasoning-end", id: reasoningId }, state, context);
  }
  const at = Date.now();
  for (const [callID, partId] of state.pendingTools) {
    advancePart(
      partId,
      options.aborted
        ? { to: "interrupted", at }
        : { to: "error", at, error: "Processing was interrupted" },
      context,
    );
    context.sink.onToolResult({
      id: crypto.randomUUID(),
      toolCallId: callID,
      output: "Processing was interrupted",
      isError: true,
    });
  }
  state.pendingTools.clear();
}

/**
 * #532 candidate 2: when a run aborts, results for tools the SDK already
 * executed may still be sitting in the stream. Recording those tools as
 * interrupted would misreport a real side effect, so before the abort is
 * surfaced the processor drains tool settlement events (only) for a bounded
 * grace window. Stops early once every pending tool is settled; never blocks
 * longer than the grace on a dead stream.
 */
const ABORT_SETTLE_GRACE_MS = 250;

export async function drainToolSettlements(
  iterator: AsyncIterator<StreamEvent>,
  firstEvent: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): Promise<void> {
  const deadline = Date.now() + ABORT_SETTLE_GRACE_MS;
  let event: StreamEvent = firstEvent;
  while (state.pendingTools.size > 0) {
    if (event.type === "tool-result" || event.type === "tool-error") {
      handleStreamEvent(event, state, context);
      if (state.pendingTools.size === 0) return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const next = await Promise.race([
      iterator.next().then(
        (result) => (result.done ? undefined : result.value),
        () => undefined,
      ),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
    if (next === undefined) return;
    event = next;
  }
}
