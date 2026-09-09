import type { LedgerAction } from "@openomni/protocol";

/** The action at `index`, or a failure naming the missing position. */
export function nth(actions: readonly LedgerAction.Node[], index: number): LedgerAction.Node {
  const action = actions[index];
  if (action === undefined) throw new Error(`missing action ${index}`);
  return action;
}
