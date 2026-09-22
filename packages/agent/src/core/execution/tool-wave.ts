import { Effect } from "effect";
import type { Message } from "@openomni/protocol";
import type { ExecutionError } from "../../errors";
import type { ChatAgentConfig } from "../types";
import { recordToolCall } from "../budget";
import type { RunState, TurnArtifacts } from "./state";

export interface WaveControl {
  readonly signal: AbortSignal;
  readonly retain?: (effect: Promise<void>) => void;
}


/** Assemble tool results on the original assistant slots, never completion order. */
export function settleModelTools(
  turn: TurnArtifacts,
  config: ChatAgentConfig,
  state: RunState,
): Effect.Effect<number, ExecutionError> {
  return Effect.gen(function* () {
  const assistant = turn.turnAssistant.message;
  const pending =
    assistant?.parts.filter(
      (part: Message.Part): part is Message.ToolPart =>
        part.type === "tool" &&
        (part.state.status === "pending" || part.state.status === "running"),
    ) ?? [];
  if (assistant === undefined || pending.length === 0) return 0;
  const calls = pending.map((part) => ({
    id: part.callID,
    tool: part.tool,
    input: part.state.input,
  }));
  const execute = turn.toolExecutor;
  if (config.toolWave === undefined && execute === undefined)
    throw new Error("tool wave executor is required");
  const executed =
    config.toolWave !== undefined
      ? yield* config.toolWave(calls, config.signal)
      : yield* Effect.forEach(calls, (call) => {
          if (execute === undefined) throw new Error("tool executor missing");
          return execute(call, { signal: config.signal }).pipe(Effect.catchAll((error) => Effect.succeed({
            id: call.id,
            toolCallId: call.id,
            toolName: call.tool,
            output: error.message,
            isError: true,
          })));
        }, { concurrency: "unbounded" });
  const results = calls.map((call) => {
    const result = executed.find((result) => result.toolCallId === call.id);
    if (result === undefined) throw new Error(`missing tool result: ${call.id}`);
    return result;
  });
  const byId = new Map(results.map((result) => [result.toolCallId, result]));
  const at = Date.now();
  const parts = assistant.parts.map((part): Message.Part => {
    if (part.type !== "tool" || !pending.includes(part)) return part;
    const result = byId.get(part.callID);
    if (result === undefined) throw new Error(`missing tool result: ${part.callID}`);
    if (config.toolWave !== undefined) state.budgetState = recordToolCall(state.budgetState, 0);
    return {
      ...part,
      state: result.isError
        ? {
            status: "error",
            input: part.state.input,
            error: result.output,
            time: { start: at, end: at },
          }
        : {
            status: "completed",
            input: part.state.input,
            output: result.output,
            title: part.tool,
            metadata: {},
            time: { start: at, end: at },
          },
    };
  });
  turn.turnAssistant.message = { ...assistant, parts };
  for (const result of results) turn.trackingSink.onToolResult(result);
  turn.trackingSink.onMessage(turn.turnAssistant.message);
  return calls.length;
  });
}
