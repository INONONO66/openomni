import type { Message, Transcript } from "@openomni/protocol";
import { stringifyToolOutput } from "../message";
import type { StreamEvent, StreamEventState, StreamEventContext } from "./stream-events";

function resolveToolName(wireName: string, context: StreamEventContext): string {
  return context.toolNames?.get(wireName) ?? wireName;
}

export function appendPart(part: Message.Part, context: StreamEventContext): void {
  context.record({
    type: "part.appended",
    attemptId: context.attemptId,
    messageId: context.messageID,
    part,
  });
}

export function advancePart(
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

export function handleToolCall(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  // ai v6 tool-call chunks carry `input`; the v4 `args` leg fed only tests.
  const input = (event.input as Record<string, unknown>) || {};
  const callID = String(event.toolCallId);
  state.visibleOutput = true;
  // A tool call is billed assistant output too: the model emitted the name and
  // the serialized arguments, so the estimator must see them (#933).
  state.stepEmittedAssistant += `${String(event.toolName)}${JSON.stringify(input)}`;
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
  // Paired standalone traces enter running here. A session-owned provider
  // step returns pending data; its receiving executor owns execution timing.
  if (!context.externalTools) advancePart(part.id, { to: "running", at: Date.now() }, context);
  state.pendingTools.set(callID, part.id);
  context.sink.onToolCall({ id: callID, tool: part.tool, input });
}

export function handleToolResult(
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
  if (context.externalTools) advancePart(partId, { to: "running", at: Date.now() }, context);
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
      handleToolResult(event, state, context);
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
