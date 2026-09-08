import type { LedgerAction, Model, PlainObject, PlainValue } from "@openomni/protocol";
import type { Executor } from "./executor-contract";

function record(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * The model an earlier turn's last provider attempt named, read back from
 * action history. Undefined when no earlier turn attempted a chat; the current
 * turn (including its resume actions) is excluded so a resumed turn keeps its
 * own selection.
 */
export function pinnedModelSelection(
  actions: readonly LedgerAction.Node[],
  turnId: string,
): Model.Ref | undefined {
  const thisTurn = new Set<string | null>([turnId]);
  const thisTurnLlm = new Set<string | null>();
  let pinned: Model.Ref | undefined;
  for (const action of actions) {
    const intent = record(action.intent.value);
    if (action.kind === "turn" && intent.phase === "resume" && intent.turnId === turnId)
      thisTurn.add(action.id);
    if (action.kind === "llm" && thisTurn.has(action.parentId)) thisTurnLlm.add(action.id);
    if (action.kind !== "attempt" || intent.phase !== "intent" || intent.op !== "chat") continue;
    if (thisTurnLlm.has(action.parentId)) continue;
    const { provider, model } = record(intent.value);
    if (typeof provider === "string" && typeof model === "string") pinned = { provider, id: model };
  }
  return pinned;
}

/**
 * Turn boundary: a fallback an earlier turn ended on is released back to the
 * primary only through a recorded `restore_model_selection` action the policy
 * admitted. Returns the index in `chain` this turn starts from: the primary
 * when nothing was pinned or the restoration executed, the pinned fallback when
 * the policy refused it.
 */
export async function restoreModelSelection(
  executor: Pick<Executor, "run">,
  pinned: Model.Ref | undefined,
  chain: readonly Model.Ref[],
): Promise<number> {
  const primary = chain[0];
  if (pinned === undefined || primary === undefined) return 0;
  const index = chain.findIndex(
    (model) => model.provider === pinned.provider && model.id === pinned.id,
  );
  if (index <= 0) return 0;
  const outcome = await executor.run(
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
    async () => ({ restored: true }),
  );
  return outcome.terminal === "executed" ? 0 : index;
}
