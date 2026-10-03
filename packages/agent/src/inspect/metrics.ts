import type { LedgerAction, PlainValue } from "@openomni/protocol";

export interface AttemptUsage {
  readonly attemptId: string;
  readonly provenance: "reported" | "estimated" | "unknown";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

function fields(value: PlainValue | undefined): Record<string, PlainValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function token(value: PlainValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * One bounded action page contributes physical attempt results once each.
 * Usage without a durable origin marker is unknown, never silently reported.
 */
export function attemptUsage(actions: readonly LedgerAction.Node[]): AttemptUsage[] {
  const seen = new Set<string>();
  const usage: AttemptUsage[] = [];
  const attemptIntents = attemptIntentIds(actions);
  for (const action of actions) {
    const result = attemptResult(action, attemptIntents);
    if (result === undefined || seen.has(result.attemptId)) continue;
    seen.add(result.attemptId);
    usage.push(result);
  }
  return usage;
}

/**
 * #1252: physical attempts share the `llm` kind with the logical llm action;
 * an attempt intent is the row carrying the attempt ordinal in its intent.
 */
function attemptIntentIds(actions: readonly LedgerAction.Node[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.kind !== "llm") continue;
    const intent = fields(action.intent.value);
    if (intent.phase === "intent" && typeof intent.attempt === "number") ids.add(action.id);
  }
  return ids;
}

function attemptResult(
  action: LedgerAction.Node,
  attemptIntents: ReadonlySet<string>,
): AttemptUsage | undefined {
  if (action.kind !== "llm" || action.parentId === null) return undefined;
  const effect = fields(action.effect.value);
  if (!attemptIntents.has(action.parentId) && effect.usageProvenance === undefined) return undefined;
  if (effect.phase !== "result") return undefined;
  const evidence = fields(effect.evidence);
  const failures = Array.isArray(evidence.failures) ? evidence.failures : [];
  const failed = failures.find((failure) => fields(failure).tag === "LlmRunFailure");
  const record = fields(failed === undefined ? evidence.usage : fields(failed).usage);
  const origin = effect.usageProvenance;
  return {
    attemptId: action.parentId,
    provenance: origin === "reported" || origin === "estimated" ? origin : "unknown",
    inputTokens: origin === "unknown" ? null : token(record.inputTokens),
    outputTokens: origin === "unknown" ? null : token(record.outputTokens),
  };
}

/** The union of parallel tool intervals is wall time, not the sum of tool times. */
export function toolWallMs(intervals: readonly { readonly start: number; readonly end: number }[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let wall = 0;
  let start = 0;
  let end = 0;
  for (const interval of sorted) {
    if (interval.end < interval.start) continue;
    if (interval.start > end) {
      wall += end - start;
      start = interval.start;
      end = interval.end;
    } else {
      end = Math.max(end, interval.end);
    }
  }
  return wall + end - start;
}
