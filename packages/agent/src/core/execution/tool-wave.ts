import { Cause, Clock, Effect, Exit, Option } from "effect";
import type { Message } from "@openomni/protocol";
import { AgentInvariantViolation, type ExecutionError } from "../../errors";
import type { ChatAgentConfig } from "../types";
import { recordToolCall } from "../budget";
import { BOUNDED_CONCURRENCY } from "../concurrency";
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
  const startedAt = yield* Clock.currentTimeMillis;
  if (config.toolWave === undefined && execute === undefined)
    return yield* Effect.die(new Error("tool wave executor is required"));
  const executed =
    config.toolWave !== undefined
      ? yield* config.toolWave(calls, config.signal)
      : yield* Effect.forEach(calls, (call) => {
          if (execute === undefined) return Effect.die(new Error("tool executor missing"));
          return Effect.exit(Effect.suspend(() => execute(call, { signal: config.signal }))).pipe(
            Effect.flatMap((exit) => {
              if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
              if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause);
              const output = Option.match(Cause.findErrorOption(exit.cause), {
                onNone: () => Cause.pretty(exit.cause),
                onSome: (error) => error.message,
              });
              return Effect.succeed({ id: call.id, toolCallId: call.id, toolName: call.tool, output, isError: true });
            }),
          );
        }, { concurrency: BOUNDED_CONCURRENCY });
  const results = calls.map((call) => {
    const result = executed.find((result) => result.toolCallId === call.id);
    if (result === undefined) throw new AgentInvariantViolation(`missing tool result: ${call.id}`);
    return result;
  });
  const byId = new Map(results.map((result) => [result.toolCallId, result]));
  const settledAt = yield* Clock.currentTimeMillis;
  // The out-of-process wave bills its real wall time once; the in-process
  // executor path already billed per call inside prepareTurnTools.
  if (config.toolWave !== undefined) {
    const elapsedMs = settledAt - startedAt;
    for (let index = 0; index < calls.length; index += 1) {
      state.budgetState = recordToolCall(state.budgetState, index === 0 ? elapsedMs : 0);
    }
  }
  const parts = assistant.parts.map((part): Message.Part => {
    if (part.type !== "tool" || !pending.includes(part)) return part;
    const result = byId.get(part.callID);
    if (result === undefined) throw new AgentInvariantViolation(`missing tool result: ${part.callID}`);
    return {
      ...part,
      state: result.isError
        ? {
            status: "error",
            input: part.state.input,
            error: result.output,
            time: { start: startedAt, end: settledAt },
          }
        : {
            status: "completed",
            input: part.state.input,
            output: result.output,
            title: part.tool,
            metadata: {},
            time: { start: startedAt, end: settledAt },
          },
    };
  });
  turn.turnAssistant.message = { ...assistant, parts };
  for (const result of results) turn.trackingSink.onToolResult(result);
  turn.trackingSink.onMessage(turn.turnAssistant.message);
  // Exhaustion is judged (and its telemetry published) once, in handleStop's
  // stop judgment — an early fail here would terminate the run without the
  // guaranteed "budget exceeded" operational record.
  return calls.length;
  });
}
