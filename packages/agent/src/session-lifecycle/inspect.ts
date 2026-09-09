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
  return decisions.filter(
    (decision) =>
      (generation === undefined || decision.generation === generation) &&
      (ruleId === undefined || decision.matchedRuleIds.includes(ruleId)) &&
      (verdict === undefined || decision.verdict === verdict),
  );
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
    op: text(intent.op) ?? text(intent.hook) ?? null,
    at: action.ts,
    turnId,
    callId: text(effect.callId) ?? text(intent.callId) ?? request.data?.callId ?? null,
    requestId: request.data?.requestId ?? outbound.data?.message.requestId ?? null,
    peerSessionId: peerOf(intent, outbound.data),
    cause: causeOf(action, intent, effect),
    outcome: outcomeOf(action, effect, request.data, outbound.data),
    reason: reasonOf(intent, effect),
    digest: canonicalDigest({ intent: action.intent, effect: action.effect }),
  });
}

function ownTurnId(action: LedgerAction.Node): string | undefined {
  if (SessionHandleStore.turnIntent(action) !== undefined) return action.id;
  const effect = object(action.effect.value);
  const turnId = text(effect.turnId) ?? text(object(action.intent.value).turnId);
  return action.kind === "turn" || action.kind === "inbox.deliver" ? turnId : undefined;
}

function phaseOf(
  action: LedgerAction.Node,
  intent: PlainObject,
  effect: PlainObject,
): SessionHistory.Phase {
  if (action.kind === "session.configure") return "configure";
  if (action.kind === "inbox.deliver") return "delivery";
  if (action.kind === "policy.decision") return "decision";
  if (effect.phase === "checkpoint" || effect.phase === "terminal" || effect.phase === "state")
    return effect.phase;
  if (intent.phase === "intent" || intent.phase === "resume") return "intent";
  if (intent.phase === "result") return "result";
  return "record";
}

function causeOf(
  action: LedgerAction.Node,
  intent: PlainObject,
  effect: PlainObject,
): SessionHistory.Cause {
  const alarmId = text(intent.alarmId);
  if (alarmId !== undefined && typeof intent.epoch === "number" && action.kind !== "alarm.arm")
    return { kind: "alarm", alarmId, epoch: intent.epoch };
  const inboxId = text(effect.inboxId);
  if (action.kind === "inbox.deliver" && inboxId !== undefined)
    return { kind: "inbox", inboxIds: [inboxId] };
  if (action.kind === "prompt" && action.parentId === null)
    return { kind: "inbox", inboxIds: [action.id] };
  const inboxIds = Array.isArray(intent.inboxIds) ? intent.inboxIds.flatMap(texts) : [];
  if (action.parentId !== null) return { kind: "action", actionId: action.parentId };
  if (inboxIds.length > 0) return { kind: "inbox", inboxIds };
  return { kind: "root" };
}

function outcomeOf(
  action: LedgerAction.Node,
  effect: PlainObject,
  request: SessionTransition.Request | undefined,
  outbound: SessionTransition.Outbound | undefined,
): SessionHistory.Outcome | null {
  if (request !== undefined) return requestOutcome(request);
  if (outbound !== undefined) return outbound.state === "delivered" ? "executed" : "pending";
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
  if (verdict !== undefined) return text(effect.reason) ?? verdict;
  const error = object(effect.error);
  return text(error.name) ?? text(effect.reason) ?? text(effect.status) ?? null;
}

function peerOf(
  intent: PlainObject,
  outbound: SessionTransition.Outbound | undefined,
): string | null {
  if (outbound !== undefined) return outbound.message.destinationSessionId;
  return (
    text(intent.sourceSessionId) ??
    text(intent.senderSessionId) ??
    text(object(intent.message).senderSessionId) ??
    null
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

function requestsOf(
  actions: readonly LedgerAction.Node[],
  turnOf: (action: LedgerAction.Node | undefined) => string | null,
): SessionHistory.Request[] {
  const latest = new Map<string, SessionHistory.Request>();
  for (const action of actions) {
    if (action.kind !== "request" && action.kind !== "reply") continue;
    const parsed = SessionTransition.Request.safeParse(object(action.effect.value).request);
    if (!parsed.success) continue;
    const request = parsed.data;
    latest.set(request.requestId, {
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
    });
  }
  return [...latest.values()];
}

function compactionsOf(
  actions: readonly LedgerAction.Node[],
  turnOf: (action: LedgerAction.Node | undefined) => string | null,
): SessionHistory.Compaction[] {
  const compactions: SessionHistory.Compaction[] = [];
  for (const action of actions) {
    if (action.kind !== "compaction" || action.parentId === null) continue;
    const effect = object(action.effect.value);
    const result = object(effect.result);
    const discarded = object(result.discarded);
    if (effect.terminal !== "executed" || typeof result.summary !== "string") continue;
    compactions.push({
      compactionId: action.parentId,
      resultId: action.id,
      revision: action.ordinal,
      turnId: turnOf(action),
      summaryDigest: canonicalDigest(result.summary),
      firstKeptEntryId: String(result.firstKeptEntryId),
      discarded: {
        firstEntryId: String(discarded.firstEntryId),
        lastEntryId: String(discarded.lastEntryId),
        count: Number(discarded.count),
        sha256: String(discarded.sha256),
      },
      restoredBy: actions
        .filter((candidate) => restores(candidate, action.parentId))
        .map((candidate) => candidate.id),
    });
  }
  return compactions;
}

function restores(action: LedgerAction.Node, compactionId: string | null): boolean {
  const intent = object(action.intent.value);
  return (
    action.kind === "compaction" &&
    intent.op === "restore_context_projection" &&
    intent.phase === "intent" &&
    object(intent.value).compactionId === compactionId
  );
}

function object(value: PlainValue | undefined): PlainObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function texts(value: PlainValue): string[] {
  return typeof value === "string" ? [value] : [];
}

function text(value: PlainValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
