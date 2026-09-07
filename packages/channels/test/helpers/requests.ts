import { createSessionRequests, decideRequestTransition } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  type Gateway,
  type PlainValue,
  type SessionTransition,
} from "@openomni/protocol";
import { Bus } from "./observation";

/** Real kernel authority and SQLite action history; no test lifecycle implementation. */
export function requestPort(
  clock: () => number = () => 1,
  onInboxCommitted?: (sessionIds: readonly string[]) => void,
) {
  return createSessionRequests({
    observations: Bus,
    clock,
    processId: "channels-test",
    onInboxCommitted,
  });
}

export function originalAction(requestId: string, sessionId: string, value: PlainValue = {}) {
  SessionHandleStore.materialize({
    id: sessionId,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: `${sessionId}:configure`,
    at: 0,
  });
  const existing = SessionHandleStore.tree(sessionId).find((action) => action.id === requestId);
  if (existing) return;
  const row = SessionHandleStore.row(sessionId);
  const lease = SessionHandleStore.acquireLease({
    sessionId,
    owner: "fixture",
    expectedFence: row.leaseFence,
    now: 1,
    expiresAt: 100,
  });
  if (!lease.ok) throw new Error("fixture lease refused");
  const result = SessionHandleStore.commit({
    sessionId,
    owner: "fixture",
    fence: lease.fence,
    expectedRevision: row.revision,
    now: 1,
    actions: [
      {
        id: requestId,
        sessionId,
        parentId: null,
        kind: "message",
        intent: {
          encodingVersion: 1,
          value: { phase: "intent", value, effectHash: canonicalDigest({}) },
        },
        effect: { encodingVersion: 1, value: {} },
        irreversible: true,
        ts: 1,
      },
    ],
    consumeInboxIds: [],
    state: "idle",
    releaseLease: true,
  });
  if (!result.ok) throw new Error("fixture commit refused");
}

export async function openRequest(requestId: string, overrides: Partial<Gateway.RequestSpec> = {}) {
  const spec: Gateway.RequestSpec = {
    requestId,
    sessionId: "request-owner",
    expectedResponders: ["actor-external-worker"],
    correlation: { channelId: "telegram:dm", tokenHash: "token-hash-1" },
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    deadline: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
  originalAction(requestId, spec.sessionId);
  return requestPort().open({ ...spec, correlation: spec.correlation ?? {}, at: 1 });
}

export function seededRequests(clock?: () => number) {
  let at = 1;
  const port = requestPort(clock ?? (() => at));
  return {
    ...port,
    open: (input: Parameters<typeof port.open>[0]) => {
      at = input.at;
      originalAction(input.requestId, input.sessionId);
      return port.open(input);
    },
  };
}

export function command(
  requestId: string,
  payload: SessionTransition.Payload,
  at: number,
  inputId = `${payload.kind}:${at}`,
) {
  const request = SessionHandleStore.requestById(requestId);
  if (!request) throw new Error("missing request");
  const sessionId = request.sessionId;
  const row = SessionHandleStore.row(sessionId);
  const lease = SessionHandleStore.acquireLease({
    sessionId,
    owner: "command",
    expectedFence: row.leaseFence,
    now: at,
    expiresAt: at + 100,
  });
  if (!lease.ok) throw new Error("command lease refused");
  const current = SessionHandleStore.row(sessionId);
  const decision = decideRequestTransition(
    {
      version: 1,
      sessionId,
      inputId,
      at,
      authority: { owner: "command", fence: lease.fence },
      expectedRevision: current.revision,
      payload,
    },
    { row: current, actions: SessionHandleStore.tree(sessionId), request },
  );
  const committed = SessionHandleStore.commitRequestTransition({
    sessionId,
    owner: "command",
    fence: lease.fence,
    now: at,
    expectedRevision: current.revision,
    actions: [...decision.actions],
    consumeInboxIds: [],
    state: current.state,
    releaseLease: true,
  });
  if (!committed.ok) throw new Error("command commit refused");
  return decision;
}

export function answer(
  requestId: string,
  responderId: string,
  inputId: string,
  receivedAt: number,
) {
  const request = SessionHandleStore.requestById(requestId);
  if (!request) throw new Error("missing request");
  return requestPort(() => receivedAt).answer({
    inputId,
    requestId,
    sessionId: request.sessionId,
    receivedAt,
    principal: { kind: "actor", principalId: responderId, evidenceId: inputId },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "reply",
    allowedAction: "report_result",
    content: `answer:${inputId}`,
  });
}
