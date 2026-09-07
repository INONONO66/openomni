import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, PlainValue } from "@openomni/protocol";
import type { ChatAgentConfig } from "../types";
import { recordToolCall } from "../budget";
import type { RunState, TurnArtifacts } from "./state";

/** Nested calls inherit ownership as well as cancellation after a body detaches. */
export const waveBodyScope = new AsyncLocalStorage<WaveControl>();

export type WaveBodyOutcome =
  | { readonly status: "fulfilled"; readonly value: PlainValue }
  | { readonly status: "rejected"; readonly error: Error }
  | { readonly status: "cancelled" };

export interface WaveBody {
  readonly sequential?: true;
  run(): Promise<PlainValue>;
}

export interface WaveControl {
  readonly signal: AbortSignal;
  readonly retain?: (effect: Promise<void>) => void;
}

/** Scheduling only: the executor stages pre decisions and commits ordered settlements. */
export async function runWaveBodies(
  items: readonly WaveBody[],
  control: WaveControl,
): Promise<readonly WaveBodyOutcome[]> {
  const outcomes = new Map<number, WaveBodyOutcome>();
  const aborted = Promise.withResolvers<void>();
  const abort = () => {
    for (const index of items.keys()) {
      if (!outcomes.has(index)) outcomes.set(index, { status: "cancelled" });
    }
    aborted.resolve();
  };
  control.signal.addEventListener("abort", abort, { once: true });
  if (control.signal.aborted) abort();
  const start = (item: WaveBody, index: number): Promise<void> => {
    const effect = waveBodyScope.run(control, async () => {
      try {
        control.signal.throwIfAborted();
        const value = await item.run();
        if (!outcomes.has(index)) outcomes.set(index, { status: "fulfilled", value });
      } catch (error) {
        if (!outcomes.has(index))
          outcomes.set(index, {
            status: "rejected",
            error: error instanceof Error ? error : new Error(String(error)),
          });
      }
    });
    control.retain?.(effect);
    return effect;
  };
  const join = (group: readonly Promise<void>[]) =>
    Promise.race([Promise.all(group), aborted.promise]);
  try {
    let group: Promise<void>[] = [];
    for (const [index, item] of items.entries()) {
      if (control.signal.aborted) break;
      if (item.sequential) {
        await join(group);
        group = [];
        if (control.signal.aborted) break;
        await join([start(item, index)]);
      } else group.push(start(item, index));
    }
    await join(group);
    return items.map((_item, index) => {
      const outcome = outcomes.get(index) ?? { status: "cancelled" as const };
      outcomes.set(index, outcome);
      return outcome;
    });
  } finally {
    control.signal.removeEventListener("abort", abort);
  }
}

/** Assemble tool results on the original assistant slots, never completion order. */
export async function settleModelTools(
  turn: TurnArtifacts,
  config: ChatAgentConfig,
  state: RunState,
): Promise<number> {
  const assistant = turn.turnAssistant.message;
  const pending =
    assistant?.parts.filter(
      (part): part is Message.ToolPart =>
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
      ? await config.toolWave(calls, config.signal)
      : await Promise.all(
          calls.map(async (call) => {
            if (execute === undefined) throw new Error("tool executor missing");
            try {
              return await execute(call, { signal: config.signal });
            } catch (error) {
              return {
                id: call.id,
                toolCallId: call.id,
                toolName: call.tool,
                output: error instanceof Error ? error.message : String(error),
                isError: true,
              };
            }
          }),
        );
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
}
