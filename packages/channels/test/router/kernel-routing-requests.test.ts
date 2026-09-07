import { openRequest, requestPort, seededRequests } from "../helpers/requests";
import { beforeEach, expect, test } from "bun:test";
import { Channel, Ingress, type Gateway } from "@openomni/protocol";
import {
  ActorRegistry,
  BlacklistStore,
  Storage,
  SurfaceKey,
  SessionHandleStore,
} from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";
import {
  commits,
  kernelRouter,
  makeRouter,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

const sender = { kind: "external", surface: "telegram", externalId: "seller-1" } as const;
function facts(
  eventId: string,
  payload: Gateway.IngressFacts["payload"] = { action: "report_result", output: "SN-A2334" },
): Gateway.IngressFacts {
  return {
    eventId,
    surface: "telegram",
    channelId: "telegram:dm",
    addressees: [],
    dm: true,
    reply: { chain: [], tokenHash: "token-hash-1" },
    payload,
    render: "SN-A2334",
  };
}
function scope(id: string) {
  return { surface: "telegram", channel: "telegram:dm", id: `telegram::telegram%3Adm:${id}` };
}
function registerResponder(actorId = "actor-external-worker", externalId = "seller-1"): void {
  ActorRegistry.registerIdentity({ id: actorId, kind: "human", trustTier: "assigned_worker" });
  ActorRegistry.registerEndpoint({
    id: `telegram:${externalId}`,
    actorId,
    channel: "telegram",
    externalId,
  });
}

beforeEach(() => {
  resetRouterState();
  registerResponder();
});

test("correlated reply resolves the request and commits only to its owner", async () => {
  await openRequest("request-session-owner");
  SurfaceKey.claim(
    Channel.SurfaceKey.fromChannel({
      surface: "telegram",
      namespace: "telegram",
      kind: "dm",
      id: "telegram:dm",
    }),
    "surface-conflict",
  );
  const result = await kernelRouter().ingest(sender, facts("reply"));
  expect(result).toMatchObject({
    status: "executed",
    handle: { target: "request-owner" },
    delivery: { kind: "session" },
  });
  expect(routingDecisions()).toHaveLength(1);
  expect(routingDecisions()[0]).toMatchObject({
    stage: "request_correlation",
    outcome: "route",
    sessionId: "request-owner",
  });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.sessionId).toBe("request-owner");
  expect(SessionHandleStore.requestById("request-session-owner")).toMatchObject({
    state: "resolved",

    replies: [{ replyId: scope("reply").id, responderId: "actor-external-worker" }],
  });
});

test("first quorum reply commits input but leaves the request open", async () => {
  await openRequest("quorum", {
    expectedResponders: ["actor-external-worker", "b", "c"],
    resolution: "quorum",
    threshold: 2,
  });
  expect(await kernelRouter().ingest(sender, facts("reply"))).toMatchObject({
    status: "executed",
    handle: { target: "request-owner" },
  });
  expect(SessionHandleStore.requestById("quorum")).toMatchObject({ state: "open" });
  expect(SessionHandleStore.requestById("quorum")?.replies).toHaveLength(1);
});

test("duplicate unresolved reply reuses its receipt without another durable input", async () => {
  await openRequest("duplicate", {
    expectedResponders: ["actor-external-worker", "b"],
    resolution: "quorum",
    threshold: 2,
  });
  await kernelRouter().ingest(sender, facts("reply"));
  const before = SessionHandleStore.tree("request-owner");
  await kernelRouter().ingest(sender, facts("reply"));
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
  expect(SessionHandleStore.inboxRows("request-owner")).toHaveLength(1);
  expect(SessionHandleStore.requestById("duplicate")?.replies).toHaveLength(1);
  expect(commits).toHaveLength(1);
});

test("late reply lazily expires the request while retaining partial progress", async () => {
  await openRequest("late", {
    expectedResponders: ["actor-external-worker", "b"],
    resolution: "quorum",
    threshold: 2,
    deadline: 10_000,
  });
  const request = SessionHandleStore.requestById("late");
  if (!request) throw new Error("missing request");
  expect(
    await requestPort().answer({
      inputId: "early",
      requestId: "late",
      sessionId: request.sessionId,
      receivedAt: 1000,
      principal: { kind: "actor", principalId: "b", evidenceId: "early" },
      bindingDigest: request.bindingDigest,
      inputHash: request.inputHash,
      effectHash: request.effectHash,
      generation: request.generation,
      toolsHash: request.toolsHash,
      domainRevisions: request.domainRevisions,
      decision: "reply",
      allowedAction: "report_result",
      content: "partial",
    }),
  ).toBe("attached");
  await expect(
    makeRouter({ clock: () => 10_001 }).ingest(sender, facts("late")),
  ).rejects.toMatchObject({
    code: "request_reply_rejected",
    message: "request reply rejected: late_unknown",
  });
  expect(SessionHandleStore.requestById("late")).toMatchObject({
    state: "expired",
    outcome: "outcome_unknown",
  });
  expect(SessionHandleStore.requestById("late")?.replies).toHaveLength(1);
  expect(commits).toEqual([]);
});

test("resolved reply redelivery preserves the original request revision", async () => {
  await openRequest("redelivery");
  await kernelRouter().ingest(sender, facts("reply"));
  const resolved = SessionHandleStore.requestById("redelivery");
  const before = SessionHandleStore.tree("request-owner");
  await kernelRouter().ingest(sender, facts("reply"));
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
  expect(SessionHandleStore.inboxRows("request-owner")).toHaveLength(1);
  expect(SessionHandleStore.requestById("redelivery")).toEqual(resolved);
  // Kernel admission and receiving inbox are one durable transition.
  expect(commits).toHaveLength(1);
});

test.each([
  "before",
  "after",
] as const)("reply redelivery repairs a crash %s the owner inbox commit without another input", async (site) => {
  await openRequest("handoff");
  let fault = true;
  let now = 10;
  const requests = requestPort(() => now);
  const router = makeRouter({
    clock: () => now,
    requests: {
      ...requests,
      answer: async (input) => {
        if (fault && site === "before") {
          fault = false;
          throw new Error("inbox handoff fault");
        }
        const resolution = await requests.answer(input);
        if (fault) {
          fault = false;
          throw new Error("inbox handoff fault");
        }
        return resolution;
      },
    },
  });
  await expect(router.ingest(sender, facts("handoff-reply"))).rejects.toThrow(
    "inbox handoff fault",
  );
  expect(SessionHandleStore.requestById("handoff")?.state).toBe(
    site === "before" ? "open" : "resolved",
  );
  expect(SessionHandleStore.inboxRows("request-owner")).toHaveLength(site === "before" ? 0 : 1);
  now = 20;
  await router.ingest(sender, facts("handoff-reply"));
  const before = SessionHandleStore.tree("request-owner");
  now = 30;
  await router.ingest(sender, facts("handoff-reply"));
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
  expect(SessionHandleStore.inboxRows("request-owner")).toHaveLength(1);
  expect(SessionHandleStore.requestById("handoff")?.replies).toHaveLength(1);
});

test("unexpected responder is refused with an authoritative route correction", async () => {
  registerResponder("intruder", "intruder");
  await openRequest("intruder", { expectedResponders: ["someone-else"] });
  await expect(
    kernelRouter().ingest({ ...sender, externalId: "intruder" }, facts("reply")),
  ).rejects.toMatchObject({
    code: "request_reply_rejected",
    message: "request reply rejected: rejected",
  });
  expect(SessionHandleStore.requestById("intruder")).toMatchObject({ state: "open", replies: [] });
  expect(Storage.get().ledger?.headFact(Ingress.routeStreamId(scope("reply")))?.type).toBe(
    "route.decided",
  );
  expect(
    Storage.get().ledger?.headFact(Ingress.routeCorrectionStreamId(scope("reply"))),
  ).toMatchObject({ type: "route.not_delivered", seq: 1 });
  expect(commits).toEqual([]);
});

test("same-precedence ambiguity is denied before inbox commit", async () => {
  await openRequest("a");
  await openRequest("b");
  expect(await kernelRouter().ingest(sender, facts("reply"))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({
    stage: "request_correlation",
    outcome: "ambiguous",
    candidateInteractionIds: ["request:a", "request:b"],
  });
  expect(commits).toEqual([]);
});

test.each([
  "throw",
  "empty_conflict",
] as const)("route correction %s fails closed", async (fault) => {
  await openRequest("correction", { expectedResponders: ["someone-else"] });
  const adapter = Storage.get();
  const ledger = adapter.ledger;
  if (ledger === undefined) throw new Error("missing ledger");
  Storage.configure({
    ...adapter,
    transaction: adapter.transaction.bind(adapter),
    ledger: {
      ...ledger,
      append: (fact, expected) => {
        if (fact.type !== Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE)
          return ledger.append(fact, expected);
        if (fault === "throw") throw new Error("correction unavailable");
        return { kind: "cas_conflict", currentHead: 0 };
      },
      headFact: (id) => (id.startsWith("route_correction:") ? undefined : ledger.headFact(id)),
    },
  });
  await expect(kernelRouter().ingest(sender, facts("reply"))).rejects.toMatchObject({
    code: "route_record_failed",
  });
  expect(commits).toEqual([]);
});

test("recorded rejection correction is idempotent", async () => {
  await openRequest("correction", {
    expectedResponders: ["actor-external-worker", "b"],
    resolution: "quorum",
    threshold: 2,
  });
  await kernelRouter().ingest(sender, facts("reply"));
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await expect(kernelRouter().ingest(sender, facts("another-reply"))).rejects.toMatchObject({
      code: "request_reply_rejected",
    });
  }
  expect(
    Storage.get().ledger?.headFact(Ingress.routeCorrectionStreamId(scope("another-reply"))),
  ).toMatchObject({ type: "route.not_delivered", seq: 1 });
  expect(commits).toHaveLength(1);
});

test.each([
  "ask_clarification",
  "invalid",
])("disallowed request action %s never falls through to the surface", async (action) => {
  await openRequest("disallowed");
  expect(await kernelRouter().ingest(sender, facts("reply", { action }))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({ stage: "request_correlation", outcome: "block" });
  expect(SessionHandleStore.requestById("disallowed")).toMatchObject({
    state: "open",
    replies: [],
  });
  expect(commits).toEqual([]);
});

test("awaited send resolves quorum from distinct authenticated responder endpoints", async () => {
  registerResponder("r1", "responder-1");
  registerResponder("r2", "responder-2");
  registerResponder("target", "target");
  const messaging = createExistingAgentMessaging({
    requests: seededRequests(),
    deliver: () => ({ value: "accepted", externalMessageId: "platform-message" }),
    grants: () => [
      { id: "grant", senderId: "owner", targetActorId: "target", operations: ["awaited"] },
    ],
    publish: Bus.publish,
  });
  const sent = await messaging.send({
    messageId: "outbound",
    senderId: "owner",
    target: { actorId: "target" },
    operation: "awaited",
    body: "verdict",
    at: 1,
    traceId: "trace",
    requestSpec: {
      requestId: "quorum",
      sessionId: "request-owner",
      allowedActions: ["report_result"],
      expectedResponders: ["r1", "r2", "r3"],
      resolution: "quorum",
      threshold: 2,
      deadline: Number.MAX_SAFE_INTEGER,
      correlation: { channelId: "telegram:dm" },
    },
  });
  expect(sent).toMatchObject({
    kind: "sent",
    operation: "awaited",
    request: {
      correlation: { endpointId: "telegram:target", replyToMessageId: "platform-message" },
    },
  });
  for (const externalId of ["responder-1", "responder-2"]) {
    expect(
      await kernelRouter().ingest(
        { ...sender, externalId },
        { ...facts(externalId), reply: { chain: [], replyToMessageId: "platform-message" } },
      ),
    ).toMatchObject({ status: "executed", handle: { target: "request-owner" } });
    expect(SessionHandleStore.requestById("quorum")?.state).toBe(
      externalId === "responder-1" ? "open" : "resolved",
    );
  }
  expect(
    SessionHandleStore.requestById("quorum")?.replies.map((reply) => reply.responderId),
  ).toEqual(["r1", "r2"]);
  expect(commits).toHaveLength(2);
});

test("blacklist takes precedence over reply correlation", async () => {
  await openRequest("blacklisted");
  BlacklistStore.put({
    id: "blocked",
    kind: "endpoint",
    value: "telegram:seller-1",
    createdBy: "owner",
  });
  expect(await kernelRouter().ingest(sender, facts("reply"))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({ stage: "blacklist", outcome: "drop" });
  expect(SessionHandleStore.requestById("blacklisted")).toMatchObject({
    state: "open",
    replies: [],
  });
  expect(commits).toEqual([]);
});
