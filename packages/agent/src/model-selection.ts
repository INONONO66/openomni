import type { LedgerAction, Model, PlainObject, PlainValue } from "@openomni/protocol";

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
