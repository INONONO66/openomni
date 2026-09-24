import { SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, Model, PlainObject, PlainValue } from "@openomni/protocol";
import { Effect } from "effect";
import type { ExecutionError } from "./errors";
import type { Executor } from "./executor-contract";

function record(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** A route switch is evidence on the newly admitted attempt, not a rewritten selection. */
export function attemptRouteChange(
  previous: LedgerAction.Receipt | undefined,
  next: PlainValue,
): PlainValue {
  if (previous === undefined) return null;
  const from = record(record(previous.action.intent.value).value);
  const to = record(next);
  if (typeof from.provider !== "string" || typeof from.model !== "string" ||
      typeof to.provider !== "string" || typeof to.model !== "string") return null;
  if (from.provider === to.provider && from.model === to.model) return null;
  return {
    kind: "route.changed",
    from: { provider: from.provider, model: from.model },
    to: { provider: to.provider, model: to.model },
    fromActionId: previous.action.id,
  };
}

/**
 * The model an earlier turn's last provider attempt named, read back from
 * action history. Undefined when no earlier turn attempted a chat; the current
 * turn (including its resume actions) is excluded so a resumed turn keeps its
 * own selection.
 */
export function pinnedModelSelection(
  sessionId: string,
  turnId: string,
): Model.Ref | undefined {
  const action = SessionHandleStore.priorModelAttempt(sessionId, turnId);
  const { provider, model } = record(record(action?.intent.value).value);
  return typeof provider === "string" && typeof model === "string" ? { provider, id: model } : undefined;
}

/**
 * Turn boundary: a fallback an earlier turn ended on is released back to the
 * primary only through a recorded `restore_model_selection` action the policy
 * admitted. Returns the index in `chain` this turn starts from: the primary
 * when nothing was pinned or the restoration executed, the pinned fallback when
 * the policy refused it.
 */
export function restoreModelSelection(
  executor: Pick<Executor, "run">,
  pinned: Model.Ref | undefined,
  chain: readonly Model.Ref[],
): Effect.Effect<number, ExecutionError> {
  return Effect.suspend(() => {
  const primary = chain[0];
  if (pinned === undefined || primary === undefined) return Effect.succeed(0);
  const index = chain.findIndex(
    (model) => model.provider === pinned.provider && model.id === pinned.id,
  );
  if (index <= 0) return Effect.succeed(0);
  return executor.run(
    {
      kind: "llm",
      op: "restore_model_selection",
      intent: {
        from: { provider: pinned.provider, id: pinned.id },
        to: { provider: primary.provider, id: primary.id },
      },
      effect: { model: { provider: primary.provider, id: primary.id } },
      recovery: "local_transactional",
    },
    () => Effect.succeed({ restored: true }),
  ).pipe(Effect.map((outcome) => outcome.terminal === "executed" ? 0 : index));
  });
}
