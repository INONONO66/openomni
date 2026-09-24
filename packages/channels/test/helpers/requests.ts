import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { Effect, Layer } from "effect";
import { Clock, Entropy, createSessionRequests, decideRequestTransition, type SessionRuntime } from "@openomni/agent";
import { runEffect } from "./effect";
import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  type Gateway,
  type PlainValue,
  type SessionTransition,
} from "@openomni/protocol";

/** Real kernel authority and SQLite action history; no test lifecycle implementation. */
export function requestPort(
  clock: () => number = () => 1,
  onInboxCommitted?: (sessionIds: readonly string[]) => void,
  runtime: Omit<SessionRuntime, "processId" | "onInboxCommitted"> = {},
) {
  return runEffect(
    createSessionRequests({ ...runtime, processId: "channels-test", onInboxCommitted }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(Clock, { now: clock }),
        Layer.succeed(Entropy, { next: () => crypto.randomUUID() }),
      )),
    ),
    "sync",
  );
}

export function originalAction(requestId: string, sessionId: string, value: PlainValue = {}) {
  Effect.runSync(SessionHandleStore.materialize({
    id: sessionId,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: `${sessionId}:configure`,
    at: 0,
  }));
  const existing = sessionTree(sessionId).find((action) => action.id === requestId);
  if (existing) return;
  const row = SessionHandleStore.row(sessionId);
  const lease = Effect.runSync(SessionHandleStore.acquireLease({
    sessionId,
    owner: "fixture",
    expectedFence: row.leaseFence,
    now: 1,
    expiresAt: 100,
  }));
  if (!lease.ok) throw new Error("fixture lease refused");
  const result = Effect.runSync(SessionHandleStore.commit({
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
  }));
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

export async function command(
  requestId: string,
  payload: SessionTransition.Payload,
  at: number,
  inputId = `${payload.kind}:${at}`,
) {
  const request = SessionHandleStore.requestById(requestId);
  if (!request) throw new Error("missing request");
  const sessionId = request.sessionId;
  const row = SessionHandleStore.row(sessionId);
  const lease = await Effect.runPromise(SessionHandleStore.acquireLease({
    sessionId,
    owner: "command",
    expectedFence: row.leaseFence,
    now: at,
    expiresAt: at + 100,
  }));
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
    { row: current, inputRecord: SessionHandleStore.requestInputById(sessionId, inputId), invocation: SessionHandleStore.actionById(requestId), request },
  );
  const committed = await Effect.runPromise(SessionHandleStore.commitRequestTransition({
    sessionId,
    owner: "command",
    fence: lease.fence,
    now: at,
    expectedRevision: current.revision,
    actions: [...decision.actions],
    consumeInboxIds: [],
    state: current.state,
    releaseLease: true,
  }));
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
