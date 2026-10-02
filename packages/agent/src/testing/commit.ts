import type { LedgerSession } from "@openomni/protocol";
import { SessionCommitError } from "../kernel/failure";

export function requireCommit(result: LedgerSession.CommitResult): LedgerSession.Row {
  if (!result.ok) throw new SessionCommitError({ result });
  return result.row;
}
