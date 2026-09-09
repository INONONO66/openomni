import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  type LedgerAction,
  type PlainObject,
  type PlainValue,
  SessionHistory,
  SessionTransition,
} from "@openomni/protocol";

/**
 * Diagnostic projection of one session's committed actions. Pure over the
 * action list: it reads no store, runs no body and appends nothing. Payloads
 * are reduced to identities, hashes, terminals and reasons.
 */
export function inspectActions(
  sessionId: string,
  parentId: string | null,
  actions: readonly LedgerAction.Node[],
): Omit<SessionHistory.Inspection, "children"> {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const turns = new Map<string, string | null>();
  const parentOf = (action: LedgerAction.Node) =>
    action.parentId === null ? undefined : byId.get(action.parentId);
  const turnOf = (action: LedgerAction.Node | undefined): string | null => {
    if (action === undefined) return null;
    const known = turns.get(action.id);
    if (known !== undefined) return known;
    const turnId = ownTurnId(action) ?? turnOf(parentOf(action));
    turns.set(action.id, turnId);
    return turnId;
  };
  const transitions = actions.map((action) => transitionOf(action, turnOf(action)));
  return {
    sessionId,
    parentId,
    headRevision: actions.at(-1)?.ordinal ?? 0,
    transitions,
    policy: actions.flatMap((action) => policyDecisionOf(action, turnOf(action))),
    requests: requestsOf(actions, turnOf),
    compactions: compactionsOf(actions, turnOf),
  };
}

/**
 * Authoritative inspection of a stored session and, to `depth`, the sessions it
 * commissioned. Traversal follows the ledger's own `parentId` authority only; a
 * session reachable merely as an outbound destination is named by its id in the
 * transition and never read.
 */
export function inspectSession(
  sessionId: string,
  request: SessionHistory.InspectRequest = {},
): SessionHistory.Inspection {
  const { depth } = SessionHistory.InspectRequest.parse(request);
  const rows = SessionHandleStore.listRows();
  const visit = (id: string, remaining: number): SessionHistory.Inspection => {
    const current = SessionHandleStore.row(id);
    const children =
      remaining === 0
        ? []
        : rows.filter((row) => row.parentId === id).map((row) => visit(row.id, remaining - 1));
    return {
      ...inspectActions(id, current.parentId, SessionHandleStore.tree(id)),
      children,
    };
  };
  return SessionHistory.Inspection.parse(visit(sessionId, depth));
}

/** Policy decisions narrowed by generation, matched rule and verdict. */
export function inspectPolicy(
  decisions: readonly SessionHistory.PolicyDecision[],
  filter: SessionHistory.PolicyFilter = {},
): SessionHistory.PolicyDecision[] {
  const { generation, ruleId, verdict } = SessionHistory.PolicyFilter.parse(filter);
  return decisions.filter((decision) =>
    all(
      generation === undefined || decision.generation === generation,
      ruleId === undefined || decision.matchedRuleIds.includes(ruleId),
      verdict === undefined || decision.verdict === verdict,
    ),
  );
}

function all(...checks: readonly boolean[]): boolean {
  return checks.every((check) => check);
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

/** The first non-empty string among candidate payload fields, else null. */
function firstText(...values: readonly (PlainValue | undefined)[]): string | null {
  return firstDefined(...values.map(text)) ?? null;
}

function transitionOf(action: LedgerAction.Node, turnId: string | null): SessionHistory.Transition {
  const intent = object(action.intent.value);
  const effect = object(action.effect.value);
  const request = SessionTransition.Request.safeParse(effect.request);
  const outbound = SessionTransition.Outbound.safeParse(effect.outbound);
  return SessionHistory.Transition.parse({
    revision: action.ordinal,
    actionId: action.id,
    parentId: action.parentId,
    sessionId: action.sessionId,
    kind: action.kind,
    phase: phaseOf(action, intent, effect),
    op: firstText(intent.op, intent.hook),
    at: action.ts,
    turnId,
    callId: firstText(effect.callId, intent.callId, request.data?.callId),
    requestId: firstText(request.data?.requestId, outbound.data?.message.requestId),
    peerSessionId: peerOf(intent, outbound.data),
    cause: causeOf(action, intent, effect),
    outcome: outcomeOf(action, effect, request.data, outbound.data),
    reason: reasonOf(intent, effect),
    digest: canonicalDigest({ intent: action.intent, effect: action.effect }),
  });
}

function ownTurnId(action: LedgerAction.Node): string | undefined {
  if (SessionHandleStore.turnIntent(action) !== undefined) return action.id;
  if (action.kind !== "turn" && action.kind !== "inbox.deliver") return undefined;
  return firstDefined(
    text(object(action.effect.value).turnId),
    text(object(action.intent.value).turnId),
  );
}

const KIND_PHASES: Partial<Record<LedgerAction.Kind, SessionHistory.Phase>> = {
  "session.configure": "configure",
  "inbox.deliver": "delivery",
  "policy.decision": "decision",
};

function effectPhase(phase: PlainValue | undefined): SessionHistory.Phase | undefined {
  return phase === "checkpoint" || phase === "terminal" || phase === "state" ? phase : undefined;
}

function intentPhase(phase: PlainValue | undefined): SessionHistory.Phase {
  if (phase === "intent" || phase === "resume") return "intent";
  return phase === "result" ? "result" : "record";
}

function phaseOf(
  action: LedgerAction.Node,
  intent: PlainObject,
  effect: PlainObject,
): SessionHistory.Phase {
  return KIND_PHASES[action.kind] ?? effectPhase(effect.phase) ?? intentPhase(intent.phase);
}

function alarmCause(
  action: LedgerAction.Node,
  intent: PlainObject,
): SessionHistory.Cause | undefined {
  const alarmId = text(intent.alarmId);
  if (alarmId !== undefined && typeof intent.epoch === "number" && action.kind !== "alarm.arm")
    return { kind: "alarm", alarmId, epoch: intent.epoch };
  return undefined;
}

function deliveryCause(
  action: LedgerAction.Node,
  effect: PlainObject,
): SessionHistory.Cause | undefined {
  const inboxId = text(effect.inboxId);
  return action.kind === "inbox.deliver" && inboxId !== undefined
    ? { kind: "inbox", inboxIds: [inboxId] }
    : undefined;
}

function lineageCause(action: LedgerAction.Node): SessionHistory.Cause {
  if (action.parentId !== null) return { kind: "action", actionId: action.parentId };
  // Turns always descend from `session.configure`, so a root action is never a turn with inbox ids.
  return action.kind === "prompt" ? { kind: "inbox", inboxIds: [action.id] } : { kind: "root" };
}

function causeOf(
  action: LedgerAction.Node,
  intent: PlainObject,
  effect: PlainObject,
): SessionHistory.Cause {
  return alarmCause(action, intent) ?? deliveryCause(action, effect) ?? lineageCause(action);
}

function outboundOutcome(outbound: SessionTransition.Outbound): SessionHistory.Outcome {
  return outbound.state === "delivered" ? "executed" : "pending";
}

function outcomeOf(
  action: LedgerAction.Node,
  effect: PlainObject,
  request: SessionTransition.Request | undefined,
  outbound: SessionTransition.Outbound | undefined,
): SessionHistory.Outcome | null {
  if (request !== undefined) return requestOutcome(request);
  if (outbound !== undefined) return outboundOutcome(outbound);
  // A pre denial commits no intent; its decision is the call's only terminal record.
  if (action.kind === "policy.decision") return preDenial(object(action.intent.value));
  return recordedOutcome(action, effect);
}

/** The outcome an action's own record states: its turn terminal, a pending phase, or a settled terminal. */
function recordedOutcome(
  action: LedgerAction.Node,
  effect: PlainObject,
): SessionHistory.Outcome | null {
  const terminal = SessionHandleStore.turnTerminal(action);
  if (terminal !== undefined) return TURN_OUTCOMES[terminal.kind];
  if (effect.phase === "pending") return "pending";
  const settled = SessionHistory.Outcome.safeParse(effect.terminal);
  return settled.success ? settled.data : null;
}

function preDenial(intent: PlainObject): SessionHistory.Outcome | null {
  return intent.verdict === "deny" && text(intent.hook)?.endsWith(".pre") === true
    ? "blocked_pre"
    : null;
}

const TURN_OUTCOMES = {
  result: "executed",
  error: "failed",
  interrupted: "cancelled",
  waiting: "pending",
} as const satisfies Record<string, SessionHistory.Outcome>;

const REQUEST_OUTCOMES = {
  answered: "executed",
  denied: "blocked_pre",
  outcome_unknown: "outcome_unknown",
  cancelled: "cancelled",
} as const satisfies Record<string, SessionHistory.Outcome>;

function requestOutcome(request: SessionTransition.Request): SessionHistory.Outcome {
  return request.outcome === null ? "pending" : REQUEST_OUTCOMES[request.outcome];
}

function reasonOf(intent: PlainObject, effect: PlainObject): string | null {
  const terminal = text(effect.kind);
  if (effect.phase === "terminal" && terminal !== undefined) return terminal;
  const verdict = text(intent.verdict);
  if (verdict !== undefined) return firstText(effect.reason, verdict);
  return firstText(object(effect.error).name, effect.reason, effect.status);
}

function peerOf(
  intent: PlainObject,
  outbound: SessionTransition.Outbound | undefined,
): string | null {
  if (outbound !== undefined) return outbound.message.destinationSessionId;
  return firstText(
    intent.sourceSessionId,
    intent.senderSessionId,
    object(intent.message).senderSessionId,
  );
}

function policyDecisionOf(
  action: LedgerAction.Node,
  turnId: string | null,
): SessionHistory.PolicyDecision[] {
  if (action.kind !== "policy.decision") return [];
  const intent = object(action.intent.value);
  const effect = object(action.effect.value);
  return [
    SessionHistory.PolicyDecision.parse({
      revision: action.ordinal,
      actionId: action.id,
      subjectActionId: action.parentId,
      turnId,
      hook: intent.hook,
      op: intent.op,
      generation: intent.generation,
      matchedRuleIds: intent.matchedRuleIds,
      verdict: intent.verdict,
      reason: effect.reason ?? null,
      inputHash: intent.inputHash,
    }),
  ];
}

type TurnOf = (action: LedgerAction.Node | undefined) => string | null;

function requestSummary(
  request: SessionTransition.Request,
  action: LedgerAction.Node,
  turnOf: TurnOf,
): SessionHistory.Request {
  return {
    requestId: request.requestId,
    revision: action.ordinal,
    turnId: request.turnId ?? turnOf(action),
    callId: request.callId,
    mode: request.mode,
    inputHash: request.inputHash,
    state: request.state,
    outcome: requestOutcome(request),
    deadline: request.deadline,
    expectedResponders: request.expectedResponders,
    replyCount: request.replies.length,
  };
}

function requestRecord(
  action: LedgerAction.Node,
  turnOf: TurnOf,
): SessionHistory.Request | undefined {
  if (action.kind !== "request" && action.kind !== "reply") return undefined;
  const parsed = SessionTransition.Request.safeParse(object(action.effect.value).request);
  return parsed.success ? requestSummary(parsed.data, action, turnOf) : undefined;
}

function requestsOf(
  actions: readonly LedgerAction.Node[],
  turnOf: TurnOf,
): SessionHistory.Request[] {
  const latest = new Map<string, SessionHistory.Request>();
  for (const action of actions) {
    const record = requestRecord(action, turnOf);
    if (record !== undefined) latest.set(record.requestId, record);
  }
  return [...latest.values()];
}

function isRestoreIntent(action: LedgerAction.Node, intent: PlainObject): boolean {
  return all(
    action.kind === "compaction",
    intent.op === "restore_context_projection",
    intent.phase === "intent",
  );
}

function restorationTarget(action: LedgerAction.Node): string | undefined {
  const intent = object(action.intent.value);
  if (!isRestoreIntent(action, intent)) return undefined;
  const compactionId = object(intent.value).compactionId;
  return typeof compactionId === "string" ? compactionId : undefined;
}

function restorationsOf(actions: readonly LedgerAction.Node[]): Map<string, string[]> {
  const restorations = new Map<string, string[]>();
  for (const action of actions) {
    const target = restorationTarget(action);
    if (target === undefined) continue;
    const ids = restorations.get(target) ?? [];
    ids.push(action.id);
    restorations.set(target, ids);
  }
  return restorations;
}

function compactionResult(
  action: LedgerAction.Node,
): { readonly result: PlainObject; readonly summary: string } | undefined {
  const effect = object(action.effect.value);
  const result = object(effect.result);
  const { summary } = result;
  return effect.terminal === "executed" && typeof summary === "string"
    ? { result, summary }
    : undefined;
}

function discardedOf(discarded: PlainObject): SessionHistory.Compaction["discarded"] {
  return {
    firstEntryId: String(discarded.firstEntryId),
    lastEntryId: String(discarded.lastEntryId),
    count: Number(discarded.count),
    sha256: String(discarded.sha256),
  };
}

function restoredBy(restorations: ReadonlyMap<string, string[]>, compactionId: string): string[] {
  return restorations.get(compactionId) ?? [];
}

function compactionRecord(
  action: LedgerAction.Node,
  turnOf: TurnOf,
  restorations: ReadonlyMap<string, string[]>,
): SessionHistory.Compaction | undefined {
  const executed = action.kind === "compaction" ? compactionResult(action) : undefined;
  if (action.parentId === null || executed === undefined) return undefined;
  return {
    compactionId: action.parentId,
    resultId: action.id,
    revision: action.ordinal,
    turnId: turnOf(action),
    summaryDigest: canonicalDigest(executed.summary),
    firstKeptEntryId: String(executed.result.firstKeptEntryId),
    discarded: discardedOf(object(executed.result.discarded)),
    restoredBy: restoredBy(restorations, action.parentId),
  };
}

function compactionsOf(
  actions: readonly LedgerAction.Node[],
  turnOf: TurnOf,
): SessionHistory.Compaction[] {
  const restorations = restorationsOf(actions);
  return actions.flatMap((action) => {
    const record = compactionRecord(action, turnOf, restorations);
    return record === undefined ? [] : [record];
  });
}

function object(value: PlainValue | undefined): PlainObject {
  return Array.isArray(value) || typeof value !== "object" || value === null ? {} : value;
}

function text(value: PlainValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
