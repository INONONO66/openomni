import { beforeEach, expect, test } from "bun:test";
import { Channel, Ingress, type Gateway, Wait } from "@openomni/protocol";
import { ActorRegistry, BlacklistStore, Storage, SurfaceKey, WaitStore } from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";
import { WaitService } from "../../src/router/wait";
import { commits, kernelRouter, makeRouter, resetRouterState, routingDecisions } from "./_router-fixture";

const sender = { kind: "external", surface: "telegram", externalId: "seller-1" } as const;
function facts(eventId: string, payload: Gateway.IngressFacts["payload"] = { action: "report_result", output: "SN-A2334" }): Gateway.IngressFacts {
  return {
    eventId, surface: "telegram", channelId: "telegram:dm", addressees: [], dm: true,
    reply: { chain: [], tokenHash: "token-hash-1" }, payload, render: "SN-A2334",
  };
}
function scope(id: string) {
  return { surface: "telegram", channel: "telegram:dm", id: `telegram::telegram%3Adm:${id}` };
}
function registerResponder(actorId = "actor-external-worker", externalId = "seller-1"): void {
  ActorRegistry.registerIdentity({ id: actorId, kind: "human", trustTier: "assigned_worker" });
  ActorRegistry.registerEndpoint({ id: `telegram:${externalId}`, actorId, channel: "telegram", externalId });
}
function openWait(id: string, overrides: Partial<Parameters<typeof WaitService.open>[0]> = {}) {
  return WaitService.open({
    id, ownerRef: { kind: "session", id: "wait-owner" }, originMessageId: `out-${id}`,
    correlation: { channelId: "telegram:dm", tokenHash: "token-hash-1" }, allowedActions: ["report_result"],
    expectedResponders: ["actor-external-worker"], resolutionPolicy: "first_reply",
    expiresAt: Number.MAX_SAFE_INTEGER, followUpWindow: 60_000, ...overrides,
  }, "trace-test");
}

beforeEach(() => { resetRouterState(); registerResponder(); });

test("correlated reply resolves the Wait and commits only to its owner", async () => {
  openWait("wait-session-owner");
  SurfaceKey.claim(Channel.SurfaceKey.fromChannel({ surface: "telegram", namespace: "telegram", kind: "dm", id: "telegram:dm" }), "surface-conflict");
  const result = await kernelRouter().ingest(sender, facts("reply"));
  expect(result).toMatchObject({ status: "executed", handle: { target: "wait-owner" }, delivery: { kind: "session" } });
  expect(routingDecisions()).toHaveLength(1);
  expect(routingDecisions()[0]).toMatchObject({ stage: "wait_correlation", outcome: "route", sessionId: "wait-owner" });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.sessionId).toBe("wait-owner");
  expect(WaitStore.get("wait-session-owner")).toMatchObject({ status: "resolved", partial: false, replies: [{ replyKey: scope("reply").id, responderId: "actor-external-worker" }] });
});

test("first quorum reply commits input but leaves the Wait open", async () => {
  openWait("quorum", { expectedResponders: ["actor-external-worker", "b", "c"], resolutionPolicy: "quorum", quorum: { expected: 3, threshold: 2 } });
  expect(await kernelRouter().ingest(sender, facts("reply"))).toMatchObject({ status: "executed", handle: { target: "wait-owner" } });
  expect(WaitStore.get("quorum")).toMatchObject({ status: "open" });
  expect(WaitStore.get("quorum")?.replies).toHaveLength(1);
});

test("duplicate unresolved reply key is refused without attaching twice", async () => {
  openWait("duplicate", { expectedResponders: ["actor-external-worker", "b"], resolutionPolicy: "quorum", quorum: { expected: 2, threshold: 2 } });
  await kernelRouter().ingest(sender, facts("reply"));
  await expect(kernelRouter().ingest(sender, facts("reply"))).rejects.toMatchObject({ code: "wait_reply_rejected", message: "wait reply rejected: duplicate_reply" });
  expect(WaitStore.get("duplicate")?.replies).toHaveLength(1);
  expect(commits).toHaveLength(1);
});

test("late reply lazily expires the Wait while retaining partial progress", async () => {
  openWait("late", { expectedResponders: ["actor-external-worker", "b"], resolutionPolicy: "quorum", quorum: { expected: 2, threshold: 2 }, expiresAt: 10_000 });
  expect(WaitService.attachReply("late", { replyKey: "early", responderCandidates: ["b"], at: 1000 }, "trace").kind).toBe("attached");
  await expect(makeRouter({ clock: () => 10_001 }).ingest(sender, facts("late"))).rejects.toMatchObject({ code: "wait_reply_rejected", message: "wait reply rejected: deadline_passed" });
  expect(WaitStore.get("late")).toMatchObject({ status: "expired", partial: true });
  expect(WaitStore.get("late")?.replies).toHaveLength(1);
  expect(commits).toEqual([]);
});

test("resolved reply redelivery preserves the original Wait revision", async () => {
  openWait("redelivery");
  await kernelRouter().ingest(sender, facts("reply"));
  const resolved = WaitStore.get("redelivery");
  await kernelRouter().ingest(sender, facts("reply"));
  expect(WaitStore.get("redelivery")).toEqual(resolved);
  // The injected L1 port owns inbox dedupe; Wait routing does not create a second lifecycle.
  expect(commits).toHaveLength(2);
  expect(commits[0]?.id).toBe(commits[1]?.id);
});

test("unexpected responder is refused with an authoritative route correction", async () => {
  registerResponder("intruder", "intruder");
  openWait("intruder", { expectedResponders: ["someone-else"] });
  await expect(kernelRouter().ingest({ ...sender, externalId: "intruder" }, facts("reply"))).rejects.toMatchObject({ code: "wait_reply_rejected", message: "wait reply rejected: unknown_responder" });
  expect(WaitStore.get("intruder")).toMatchObject({ status: "open", replies: [] });
  expect(Storage.get().ledger?.headFact(Ingress.routeStreamId(scope("reply")))?.type).toBe("route.decided");
  expect(Storage.get().ledger?.headFact(Ingress.routeCorrectionStreamId(scope("reply")))).toMatchObject({ type: "route.not_delivered", seq: 1 });
  expect(commits).toEqual([]);
});

test("same-precedence ambiguity is denied before inbox commit", async () => {
  openWait("a"); openWait("b");
  expect(await kernelRouter().ingest(sender, facts("reply"))).toMatchObject({ status: "blocked_pre" });
  expect(routingDecisions()[0]).toMatchObject({ stage: "wait_correlation", outcome: "ambiguous", candidateInteractionIds: ["wait:a", "wait:b"] });
  expect(commits).toEqual([]);
});

test.each(["throw", "empty_conflict"] as const)("route correction %s fails closed", async (fault) => {
  openWait("correction", { expectedResponders: ["someone-else"] });
  const adapter = Storage.get();
  const ledger = adapter.ledger;
  if (ledger === undefined) throw new Error("missing ledger");
  Storage.configure({ ...adapter, transaction: adapter.transaction.bind(adapter), ledger: {
    ...ledger,
    append: (fact, expected) => {
      if (fact.type !== Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE) return ledger.append(fact, expected);
      if (fault === "throw") throw new Error("correction unavailable");
      return { kind: "cas_conflict", currentHead: 0 };
    },
    headFact: (id) => id.startsWith("route_correction:") ? undefined : ledger.headFact(id),
  } });
  await expect(kernelRouter().ingest(sender, facts("reply"))).rejects.toMatchObject({ code: "route_record_failed" });
  expect(commits).toEqual([]);
});

test("recorded rejection correction is idempotent", async () => {
  openWait("correction", { expectedResponders: ["actor-external-worker", "b"], resolutionPolicy: "quorum", quorum: { expected: 2, threshold: 2 } });
  await kernelRouter().ingest(sender, facts("reply"));
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await expect(kernelRouter().ingest(sender, facts("reply"))).rejects.toMatchObject({ code: "wait_reply_rejected" });
  }
  expect(Storage.get().ledger?.headFact(Ingress.routeCorrectionStreamId(scope("reply")))).toMatchObject({ type: "route.not_delivered", seq: 1 });
  expect(commits).toHaveLength(1);
});

test.each(["ask_clarification", "invalid"])("disallowed Wait action %s never falls through to the surface", async (action) => {
  openWait("disallowed");
  expect(await kernelRouter().ingest(sender, facts("reply", { action }))).toMatchObject({ status: "blocked_pre" });
  expect(routingDecisions()[0]).toMatchObject({ stage: "wait_correlation", outcome: "block" });
  expect(WaitStore.get("disallowed")).toMatchObject({ status: "open", replies: [] });
  expect(commits).toEqual([]);
});

test("retired owner cannot enter the Wait store", () => {
  expect(() => openWait("retired", { ownerRef: Wait.OwnerRef.parse({ kind: "workItem", id: "retired" }) })).toThrow();
  expect(WaitStore.get("retired")).toBeUndefined();
});

test("awaited send resolves quorum from distinct authenticated responder endpoints", async () => {
  registerResponder("r1", "responder-1"); registerResponder("r2", "responder-2"); registerResponder("target", "target");
  const messaging = createExistingAgentMessaging({
    deliver: () => ({ value: "accepted", externalMessageId: "platform-message" }),
    grants: () => [{ id: "grant", senderId: "owner", targetActorId: "target", operations: ["awaited"] }], publish: Bus.publish,
  });
  const sent = await messaging.send({
    messageId: "outbound", senderId: "owner", target: { actorId: "target" }, operation: "awaited", body: "verdict", at: 1, traceId: "trace",
    waitSpec: { waitId: "quorum", ownerRef: { kind: "session", id: "wait-owner" }, allowedActions: ["report_result"],
      expectedResponders: ["r1", "r2", "r3"], resolutionPolicy: "quorum", quorum: { expected: 3, threshold: 2 },
      expiresAt: Number.MAX_SAFE_INTEGER, followUpWindow: 0, correlation: { channelId: "telegram:dm" } },
  });
  expect(sent).toMatchObject({ kind: "sent", operation: "awaited", wait: { correlation: { endpointId: "telegram:target", replyToMessageId: "platform-message" } } });
  for (const externalId of ["responder-1", "responder-2"]) {
    expect(await kernelRouter().ingest({ ...sender, externalId }, { ...facts(externalId), reply: { chain: [], replyToMessageId: "platform-message" } }))
      .toMatchObject({ status: "executed", handle: { target: "wait-owner" } });
    expect(WaitStore.get("quorum")?.status).toBe(externalId === "responder-1" ? "open" : "resolved");
  }
  expect(WaitStore.get("quorum")?.replies.map((reply) => reply.responderId)).toEqual(["r1", "r2"]);
  expect(commits).toHaveLength(2);
});

test("blacklist takes precedence over reply correlation", async () => {
  openWait("blacklisted");
  BlacklistStore.put({ id: "blocked", kind: "endpoint", value: "telegram:seller-1", createdBy: "owner" });
  expect(await kernelRouter().ingest(sender, facts("reply"))).toMatchObject({ status: "blocked_pre" });
  expect(routingDecisions()[0]).toMatchObject({ stage: "blacklist", outcome: "drop" });
  expect(WaitStore.get("blacklisted")).toMatchObject({ status: "open", replies: [] });
  expect(commits).toEqual([]);
});
