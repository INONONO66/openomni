import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { Effect, Layer } from "effect";
import { Clock, Entropy, createSessionRequests, decideRequestTransition, type SessionRuntime } from "@openomni/agent";
import { runEffect } from "./effect";
import {
  canonicalDigest,
  type Gateway,
  type PlainValue,
  type SessionTransition,
} from "@openomni/protocol";
import { ledger } from "./ledger";

/** Channel tests exercise routing, not configure authority: the pinned pre-policy admits every configure. */
const allowConfigure: SessionRuntime["authorizeConfigure"] = () => Effect.succeed(true);

/** Strictly-newer fence adoption: the takeover CAS that replaced leases (W5.2 F5). */
function adoptFixtureFence(sessionId: string, owner: string): number {
  const kernel = ledger().kernel;
  for (;;) {
    const row = kernel.row(sessionId);
    if (row.leaseOwner === owner) return row.leaseFence;
    const adopted = Effect.runSync(
      kernel.adoptFence({ sessionId, owner, fence: row.leaseFence + 1 }).pipe(
        Effect.map((receipt) => receipt.fence),
        Effect.catchTag("LeaseRefused", () => Effect.succeed(undefined)),
      ),
    );
    if (adopted !== undefined) return adopted;
  }
}

/** Real kernel authority and SQLite action history; no test lifecycle implementation. */
export function requestPort(
  clock: () => number = () => 1,
  onInboxCommitted?: (sessionIds: readonly string[]) => void,
  runtime: Partial<Omit<SessionRuntime, "processId" | "onInboxCommitted" | "authorizeConfigure">> = {},
) {
  return runEffect(
    createSessionRequests({
      openKernel: () => ledger().kernel,
      listSessions: () => ledger().kernel.listRows(),
      ...runtime,
      authorizeConfigure: allowConfigure,
      processId: "channels-test",
      onInboxCommitted,
    }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(Clock, { now: clock }),
        Layer.succeed(Entropy, { next: () => crypto.randomUUID() }),
      )),
    ),
    "sync",
  );
}

export function originalAction(requestId: string, sessionId: string, value: PlainValue = {}) {
  const kernel = ledger().kernel;
  Effect.runSync(
    kernel
      .materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 0,
        actionId: `${sessionId}:configure`,
        at: 0,
      })
      .pipe(Effect.orDie),
  );
  const existing = sessionTree(sessionId, ledger().sessions.actions).find(
    (action) => action.id === requestId,
  );
  if (existing) return;
  const fence = adoptFixtureFence(sessionId, "fixture");
  const row = kernel.row(sessionId);
  Effect.runSync(kernel.commit({
    sessionId,
    owner: "fixture",
    fence,
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
    state: "idle",
  }));
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
  const at = { value: 1 };
  const port = requestPort(clock ?? (() => at.value));
  return {
    ...port,
    open: (input: Parameters<typeof port.open>[0]) => {
      at.value = input.at;
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
  const kernel = ledger().kernel;
  const request = kernel.requestById(requestId);
  if (!request) throw new Error("missing request");
  const sessionId = request.sessionId;
  const fence = adoptFixtureFence(sessionId, "command");
  const current = kernel.row(sessionId);
  const decision = decideRequestTransition(
    {
      version: 1,
      sessionId,
      inputId,
      at,
      authority: { owner: "command", fence },
      expectedRevision: current.revision,
      payload,
    },
    {
      row: current,
      inputRecord: kernel.requestInputById(sessionId, inputId),
      invocation: kernel.actionById(requestId),
      request,
    },
  );
  await Effect.runPromise(kernel.commitRequestTransition({
    sessionId,
    owner: "command",
    fence,
    now: at,
    expectedRevision: current.revision,
    actions: [...decision.actions],
    state: current.state,
  }));
  return decision;
}

export function answer(
  requestId: string,
  responderId: string,
  inputId: string,
  receivedAt: number,
) {
  const request = ledger().kernel.requestById(requestId);
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
