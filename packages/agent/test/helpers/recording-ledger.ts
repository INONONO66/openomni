import { LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import { fixtureHashes } from "./compiled-policy";

/** One in-memory chain writer for executor and chat-loop fixtures. */
export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  return {
    committed,
    entropy: () => `action-${ordinal + 1}`,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        Effect.sync(() => {
          committed.push(action);
          ordinal += 1;
          return {
            action: LedgerAction.Node.parse({ ...action, ordinal, ...fixtureHashes(ordinal) }),
            revision: ordinal,
          };
        }),
    },
  };
}
