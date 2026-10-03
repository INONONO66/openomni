import type { LedgerAction } from "@openomni/protocol";

type Row = Pick<LedgerAction.Append, "kind" | "intent" | "effect" | "parentId"> & {
  readonly id: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * #1252: physical attempts share the `llm` kind with the logical llm action.
 * An attempt intent is the llm row pinning its attempt ordinal; an attempt
 * result is the llm row settling such an intent.
 */
export function isAttemptIntent(action: Row): boolean {
  return action.kind === "llm" && typeof record(action.intent.value).attempt === "number";
}

export function attemptIntentIds(actions: readonly Row[]): ReadonlySet<string> {
  return new Set(actions.filter(isAttemptIntent).map((action) => action.id));
}

export function isAttemptRow(action: Row, attemptIds: ReadonlySet<string>): boolean {
  if (action.kind !== "llm") return false;
  if (isAttemptIntent(action)) return true;
  // An attempt result settles an attempt intent; other children of an attempt
  // intent (e.g. a restoration branch parented on it) are logical rows.
  return (
    attemptIds.has(action.parentId ?? "") && record(action.intent.value).phase === "result"
  );
}

export function isLogicalLlm(action: Row, attemptIds: ReadonlySet<string>): boolean {
  return action.kind === "llm" && !isAttemptRow(action, attemptIds);
}
