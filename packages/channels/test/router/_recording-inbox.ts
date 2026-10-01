import { Effect } from "effect";
import type { Inbox } from "@openomni/protocol";

export function recordingInbox(commits: Inbox.Commit[]) {
  return {
    commit: (row: Inbox.Commit) => Effect.sync(() => {
      commits.push(row);
      return { ...row, status: "pending" as const, consumedBy: null, consumedAt: null, ordinal: 1 };
    }),
  };
}
