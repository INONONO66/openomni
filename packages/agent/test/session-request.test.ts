import { expect, it } from "bun:test";
import {
  canonicalDigest,
  type LedgerAction,
  type LedgerSession,
  type SessionTransition,
} from "@openomni/protocol";
import { decideRequestTransition, requestBindingDigest } from "../src/session-request";

const row: LedgerSession.Row = {
  id: "session",
  parentId: null,
  role: "resident",
  leaseOwner: "kernel",
  leaseFence: 1,
  leaseExpiresAt: 1000,
  revision: 1,
  state: "running",
  toolsGeneration: 1,
  systemHash: "system",
  policyGeneration: 1,
};
const original: LedgerAction.Node = {
  id: "invocation",
  sessionId: "session",
  parentId: null,
  kind: "tool",
  ts: 1,
  ordinal: 1,
  intent: {
    encodingVersion: 1,
    value: {
      phase: "intent",
      op: "write",
      value: { path: "original" },
      effectHash: canonicalDigest({ category: "mutation" }),
      domainRevisions: { person: 3 },
    },
  },
  effect: { encodingVersion: 1, value: { phase: "pending" } },
  irreversible: true,
};
function request(): SessionTransition.Request {
  const value: SessionTransition.Request = {
    requestId: "invocation",
    sessionId: "session",
    turnId: null,
    callId: "call",
    mode: "approval",
    parsedInput: { path: "original" },
    inputHash: canonicalDigest({ path: "original" }),
    effectHash: canonicalDigest({ category: "mutation" }),
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: { person: 3 },
    deadline: 100,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
  };
  value.bindingDigest = requestBindingDigest(value);
  return value;
}
function answer(pending = request()): SessionTransition.Answer {
  return {
    inputId: "answer",
    requestId: pending.requestId,
    sessionId: pending.sessionId,
    receivedAt: 20,
    principal: { kind: "owner", principalId: "owner", evidenceId: "authenticated" },
    bindingDigest: pending.bindingDigest,
    inputHash: pending.inputHash,
    effectHash: pending.effectHash,
    generation: pending.generation,
    toolsHash: pending.toolsHash,
    domainRevisions: pending.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}
function decide(
  payload: SessionTransition.Payload,
  pending?: SessionTransition.Request,
  actions = [original],
) {
  return decideRequestTransition(
    {
      version: 1,
      inputId: payload.kind === "request.answer" ? payload.answer.inputId : payload.kind,
      sessionId: row.id,
      at: 20,
      authority: { owner: "kernel", fence: 1 },
      expectedRevision: 1,
      payload,
    },
    { row, actions, request: pending, domainRevisions: { person: 3 } },
  );
}
it("opens only the exact existing invocation and original effect", () => {
  const pending = request();
  expect(decide({ kind: "request.open", request: pending }).resolution).toBe("opened");
  expect(
    decide({ kind: "request.open", request: { ...pending, parsedInput: { path: "swapped" } } })
      .resolution,
  ).toBe("rejected");
  expect(decide({ kind: "request.open", request: pending }, undefined, []).resolution).toBe(
    "rejected",
  );
});
it("records one canonical resolution and deduplicates equivalent input after restart", () => {
  const pending = request();
  const payload = { kind: "request.answer", answer: answer(pending) } as const;
  const result = decide(payload, pending);
  expect(result.resolution).toBe("resolved");
  expect(result.request?.state).toBe("resolved");
  expect(result.actions.some((action) => action.id === "invocation:resolution")).toBe(true);
  const persisted = result.actions.map((action, index) => ({ ...action, ordinal: index + 2 }));
  const repeated = decide(
    { ...payload, answer: { ...payload.answer, receivedAt: 30 } },
    result.request,
    [original, ...persisted],
  );
  expect(repeated.resolution).toBe("resolved");
  expect(repeated.actions).toEqual([]);
  expect(
    decide({ ...payload, answer: { ...payload.answer, content: "changed" } }, result.request, [
      original,
      ...persisted,
    ]).resolution,
  ).toBe("rejected");
});
it("expires late answers before binding checks without reopening or inbox effects", () => {
  const pending = request();
  const result = decide(
    {
      kind: "request.answer",
      answer: { ...answer(pending), receivedAt: 100, bindingDigest: "forged" },
    },
    pending,
  );
  expect(result.resolution).toBe("late_unknown");
  expect(result.request?.state).toBe("expired");
  expect(result.request?.outcome).toBe("outcome_unknown");
  expect(result.actions.filter((action) => action.id === "invocation:resolution")).toHaveLength(1);
});
it("rejects non-Owner approval and changed domain revisions", () => {
  const pending = request();
  expect(
    decide(
      {
        kind: "request.answer",
        answer: {
          ...answer(),
          principal: { kind: "owner", principalId: "different-owner", evidenceId: "authenticated" },
        },
      },
      pending,
    ).resolution,
  ).toBe("rejected");
  expect(
    decide(
      {
        kind: "request.answer",
        answer: {
          ...answer(),
          principal: { kind: "actor", principalId: "owner", evidenceId: "chat" },
        },
      },
      pending,
    ).resolution,
  ).toBe("rejected");
  expect(
    decide(
      { kind: "request.answer", answer: { ...answer(), domainRevisions: { person: 4 } } },
      pending,
    ).resolution,
  ).toBe("rejected");
});
it("counts distinct responders, not repeated replies, for all and quorum", () => {
  const pending = {
    ...request(),
    mode: "reply" as const,
    expectedResponders: ["alice", "bob"],
    resolution: "all" as const,
    threshold: 2,
  };
  pending.bindingDigest = requestBindingDigest(pending);
  const first = {
    ...answer(pending),
    decision: "reply" as const,
    principal: { kind: "actor" as const, principalId: "alice", evidenceId: "driver" },
  };
  const attached = decide({ kind: "request.answer", answer: first }, pending);
  expect(attached.resolution).toBe("attached");
  const repeated = decide(
    { kind: "request.answer", answer: { ...first, inputId: "another" } },
    attached.request,
  );
  expect(repeated.resolution).toBe("duplicate");
  const resolved = decide(
    {
      kind: "request.answer",
      answer: {
        ...first,
        inputId: "bob-answer",
        principal: { ...first.principal, principalId: "bob" },
      },
    },
    attached.request,
  );
  expect(resolved.resolution).toBe("resolved");
});
it("never borrows a foreign lease or accepts an obsolete revision", () => {
  const command: SessionTransition.Command = {
    version: 1,
    inputId: "open",
    sessionId: row.id,
    at: 20,
    expectedRevision: 1,
    authority: { owner: "foreign", fence: 1 },
    payload: { kind: "request.open", request: request() },
  };
  expect(decideRequestTransition(command, { row, actions: [original] }).actions).toEqual([]);
  expect(
    decideRequestTransition(
      { ...command, authority: { owner: "kernel", fence: 1 }, expectedRevision: 0 },
      { row, actions: [original] },
    ).resolution,
  ).toBe("rejected");
});
it("accepts an expected responder's refusal as the single terminal winner", () => {
  const pending = { ...request(), mode: "reply" as const, expectedResponders: ["alice"] };
  pending.bindingDigest = requestBindingDigest(pending);
  const result = decide(
    {
      kind: "request.answer",
      answer: {
        ...answer(pending),
        principal: { kind: "actor", principalId: "alice", evidenceId: "driver" },
        decision: "refuse",
      },
    },
    pending,
  );
  expect(result.resolution).toBe("refused");
  expect(result.request?.outcome).toBe("denied");
  expect(result.actions.filter((action) => action.id === "invocation:resolution")).toHaveLength(1);
});
it("refuses approval when current domain revisions cannot be read", () => {
  const pending = request();
  const result = decideRequestTransition(
    {
      version: 1,
      inputId: "answer",
      sessionId: row.id,
      at: 20,
      expectedRevision: 1,
      authority: { owner: "kernel", fence: 1 },
      payload: { kind: "request.answer", answer: answer(pending) },
    },
    { row, actions: [original], request: pending },
  );
  expect(result.resolution).toBe("rejected");
  expect(result.request?.state).toBe("open");
});

it("proposes observed global approval count only for a new approval open", () => {
  const pending = request();
  const command: SessionTransition.Command = {
    version: 1,
    sessionId: row.id,
    inputId: "open",
    at: 20,
    expectedRevision: row.revision,
    authority: { owner: "kernel", fence: 1 },
    payload: { kind: "request.open", request: pending },
  };
  const recent = Array.from({ length: 7 }, (_, index) => ({
    ...pending,
    requestId: `other-${index}`,
    sessionId: `other-session-${index}`,
  }));
  const requests = [
    ...recent,
    { ...pending, requestId: "boundary", createdAt: 20 - 3_600_000 },
    { ...pending, requestId: "reply", mode: "reply" as const },
    { ...pending, requestId: "closed", state: "resolved" as const, outcome: "answered" as const },
  ];
  const snapshot = { row, actions: [original], requests };
  const opened = decideRequestTransition(command, snapshot);
  expect(opened.resolution).toBe("opened");
  expect(opened).toHaveProperty("requestCount", { since: 20 - 3_600_000, count: 7 });
  expect(
    decideRequestTransition(command, {
      ...snapshot,
      requests: [...requests, { ...pending, requestId: "eighth" }],
    }),
  ).toEqual({ resolution: "rejected", actions: [] });
  const persisted = opened.actions.map((action, index) => ({ ...action, ordinal: index + 2 }));
  expect(
    decideRequestTransition(command, {
      ...snapshot,
      request: opened.request,
      actions: [original, ...persisted],
    }),
  ).not.toHaveProperty("requestCount");
  const reply = { ...pending, mode: "reply" as const };
  reply.bindingDigest = requestBindingDigest(reply);
  const replyOpened = decideRequestTransition(
    {
      ...command,
      payload: { kind: "request.open", request: reply },
    },
    snapshot,
  );
  expect(replyOpened.resolution).toBe("opened");
  expect(replyOpened).not.toHaveProperty("requestCount");
});

it("pins unknown physical receipts and deduplicates without their local timestamp", () => {
  const pending = request();
  const receipt: SessionTransition.DeliveryReceipt = {
    inputId: "request.delivery",
    requestId: pending.requestId,
    sessionId: row.id,
    sourceActionId: pending.requestId,
    value: "unknown",
    externalMessageId: "physical",
    at: 10,
  };
  const recorded = decide({ kind: "request.delivery", receipt }, pending);
  expect(recorded.resolution).toBe("delivery_recorded");
  expect(recorded.request?.correlation.replyToMessageId).toBe("physical");
  expect(recorded.request?.bindingDigest).not.toBe(pending.bindingDigest);
  const persisted = recorded.actions.map((action, index) => ({ ...action, ordinal: index + 2 }));
  const repeated = decide(
    {
      kind: "request.delivery",
      receipt: { ...receipt, at: 30 },
    },
    recorded.request,
    [original, ...persisted],
  );
  expect(repeated.resolution).toBe("delivery_recorded");
  expect(repeated.actions).toEqual([]);
});

it("checks answer bindings before terminal duplication and never receives a rejected reply", () => {
  const pending = { ...request(), mode: "reply" as const };
  pending.bindingDigest = requestBindingDigest(pending);
  const reply = { ...answer(pending), decision: "reply" as const };
  const resolved = decide({ kind: "request.answer", answer: reply }, pending);
  expect(resolved.receive).toMatchObject({
    id: reply.inputId,
    sessionId: row.id,
    content: reply.content,
    parentActionId: pending.requestId,
  });
  const rejected = decide(
    {
      kind: "request.answer",
      answer: { ...reply, inputId: "forged", bindingDigest: "forged" },
    },
    resolved.request,
  );
  expect(rejected.resolution).toBe("rejected");
  expect(rejected.receive).toBeUndefined();
  const duplicate = decide(
    {
      kind: "request.answer",
      answer: { ...reply, inputId: "new-input" },
    },
    resolved.request,
  );
  expect(duplicate.resolution).toBe("duplicate");
  expect(duplicate.receive).toBeUndefined();
});

it("gives timeout and cancellation only one terminal winner", () => {
  const pending = { ...request(), deadline: 20 };
  pending.bindingDigest = requestBindingDigest(pending);
  const expired = decide({ kind: "request.timeout", requestId: pending.requestId }, pending);
  expect(expired.resolution).toBe("expired");
  const cancellation: SessionTransition.Payload = {
    kind: "request.cancel",
    requestId: pending.requestId,
    principal: { kind: "session", principalId: row.id, evidenceId: "owned" },
  };
  const lost = decide(cancellation, expired.request);
  expect(lost.resolution).toBe("duplicate");
  expect(lost.actions.some((action) => action.id.endsWith(":resolution"))).toBe(false);
  const cancelled = decide(cancellation, pending);
  expect(cancelled.resolution).toBe("cancelled");
  expect(
    decide({ kind: "request.timeout", requestId: pending.requestId }, cancelled.request).resolution,
  ).toBe("duplicate");
});
