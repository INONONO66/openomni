import { Effect } from "effect";
import type { ExecutionError } from "../errors";
import type { CompactionResult } from "./contract";
import { canonicalDigest, PlainValueSchema, type BusEvent } from "@openomni/protocol";
import type { Executor } from "../executor";
import { RunEvents } from "../core/execution/events";
import { Compaction } from "./compact";

type CompactionArguments = Parameters<typeof Compaction.compact>;

interface CompactionExecution {
  readonly history: CompactionArguments[0];
  readonly options: CompactionArguments[1];
  readonly identity: CompactionArguments[2];
  readonly events: BusEvent.Sink;
  readonly dispatch: CompactionArguments[4];
  readonly executor?: Executor;
  readonly signal?: AbortSignal;
}

class CompactionExecutionError extends Error {
  readonly code = "compaction_execution_refused";
  constructor(readonly reason: string) {
    super(`compaction execution refused: ${reason}`);
    this.name = "CompactionExecutionError";
  }
}

/** Execute the existing strategy under admission; only the receipt releases observations. */
export function executeCompaction(input: CompactionExecution): Effect.Effect<CompactionResult, ExecutionError> {
  return Effect.gen(function* () {
  const snapshot = structuredClone(input.history);
  const completed: (() => void)[] = [];
  const events: BusEvent.Sink = {
    publish(event, data) {
      if (event.name === RunEvents.CompactionStarted.name) input.events.publish(event, data);
      else completed.push(() => input.events.publish(event, data));
    },
  };
  const calculate = () => Effect.gen(function* () {
    if (input.signal?.aborted) return yield* Effect.interrupt;
    const result = yield* Compaction.compact(snapshot, input.options, input.identity, events, {
      ...input.dispatch,
      signal: input.signal,
    });
    if (input.signal?.aborted) return yield* Effect.interrupt;
    return result;
  });
  let result: CompactionResult | undefined;
  if (input.executor === undefined) {
    result = yield* calculate();
  } else {
    const execution = yield* input.executor.run(
      {
        kind: "compaction",
        op: "compact",
        intent: { trigger: input.dispatch.trigger },
        effect: {},
        boundary: true,
        revertData: () =>
          result?.record === undefined ? undefined : PlainValueSchema.parse(result.record.revert),
      },
      () => Effect.gen(function* () {
        result = yield* calculate();
        return PlainValueSchema.parse(
          result.record === undefined ? null : { ...result.record, projection: result.messages },
        );
      }),
    );
    if (execution.terminal !== "executed") throw new CompactionExecutionError(execution.reason);
    if (
      result === undefined ||
      canonicalDigest(execution.value) !==
        canonicalDigest(
          result.record === undefined ? null : { ...result.record, projection: result.messages },
        )
    ) {
      throw new CompactionExecutionError("invalid_output");
    }
  }
  for (const publish of completed) publish();
  return result;
  });
}
