import { canonicalDigest, PlainValueSchema, type BusEvent } from "@openomni/protocol";
import type { Executor } from "../executor";
import { RunEvents } from "../core/execution/events";
import { Compaction } from "./compact";

type CompactionArguments = Parameters<typeof Compaction.compact>;
type CompactionResult = Awaited<ReturnType<typeof Compaction.compact>>;

interface CompactionExecution {
  readonly history: CompactionArguments[0];
  readonly options: CompactionArguments[1];
  readonly identity: CompactionArguments[2];
  readonly events: BusEvent.Sink;
  readonly dispatch: CompactionArguments[4];
  readonly executor?: Executor;
  readonly signal?: AbortSignal;
}

export class CompactionExecutionError extends Error {
  readonly code = "compaction_execution_refused";
  constructor(readonly reason: string) {
    super(`compaction execution refused: ${reason}`);
    this.name = "CompactionExecutionError";
  }
}

/** Execute the existing strategy under admission; only the receipt releases observations. */
export async function executeCompaction(input: CompactionExecution): Promise<CompactionResult> {
  const snapshot = structuredClone(input.history);
  const completed: (() => void)[] = [];
  const events: BusEvent.Sink = {
    publish(event, data) {
      if (event.name === RunEvents.CompactionStarted.name) input.events.publish(event, data);
      else completed.push(() => input.events.publish(event, data));
    },
  };
  const calculate = async () => {
    input.signal?.throwIfAborted();
    const result = await Compaction.compact(
      snapshot,
      input.options,
      input.identity,
      events,
      { ...input.dispatch, signal: input.signal },
    );
    input.signal?.throwIfAborted();
    return result;
  };
  let result: CompactionResult | undefined;
  if (input.executor === undefined) {
    result = await calculate();
  } else {
    const execution = await input.executor.run(
      {
        kind: "compaction",
        op: "compact",
        intent: { trigger: input.dispatch.trigger },
        effect: {},
        revertData: () =>
          result?.record === undefined ? undefined : PlainValueSchema.parse(result.record.revert),
      },
      async () => {
        result = await calculate();
        return PlainValueSchema.parse(result.record ?? null);
      },
    );
    if (execution.terminal !== "executed") throw new CompactionExecutionError(execution.reason);
    if (
      result === undefined ||
      canonicalDigest(execution.value) !== canonicalDigest(result.record ?? null)
    ) {
      throw new CompactionExecutionError("invalid_output");
    }
  }
  for (const publish of completed) publish();
  return result;
}
