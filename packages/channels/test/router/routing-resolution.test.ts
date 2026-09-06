import { beforeEach, expect, test } from "bun:test";
import { Channel, Ingress, type Ledger } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage, SurfaceKey } from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import { commits, createMappedOwnerSession, makeRouter, ownerEvent, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions } from "./_router-fixture";

const streamId = () => Ingress.routeStreamId(ownerEvent);
beforeEach(resetRouterState);

test("records the channel-scoped decision before inbox commit", async () => {
  registerOwnerDm(); createMappedOwnerSession();
  const observed: Array<Ledger.RecordedFact | undefined> = [];
  const router = makeRouter({ inbox: { commit: (row) => {
    observed.push(Storage.get().ledger?.headFact(streamId()));
    return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
  } } });
  await router.ingest(ownerSender, ownerFacts);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ streamId: streamId(), seq: 1, type: "route.decided" });
});

test("blocked decisions are durable before returning the receipt", async () => {
  expect(await makeRouter().ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  expect(Storage.get().ledger?.headFact(streamId())).toMatchObject({ seq: 1, type: "route.decided", data: { outcome: "block" } });
});

test("equivalent redelivery uses one route fact and the same inbox id", async () => {
  registerOwnerDm(); createMappedOwnerSession();
  const router = makeRouter();
  await router.ingest(ownerSender, ownerFacts);
  await router.ingest(ownerSender, ownerFacts);
  expect(commits).toHaveLength(2);
  expect(commits[0]?.id).toBe(commits[1]?.id);
  expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
});

test("historical route facts upcast on redelivery without reconstructing another route", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  await makeRouter().ingest(ownerSender, ownerFacts);
  const modern = Ingress.Events.RoutingDecision.schema.parse(Storage.get().ledger?.headFact(streamId())?.data);
  resetRouterState(); registerOwnerDm();
  SurfaceKey.claim(Channel.SurfaceKey.fromChannel({ surface: "discord", namespace: "owner-workspace", kind: "dm", id: "owner-dm" }), mapped.id);
  expect(Storage.get().ledger?.append({ streamId: streamId(), type: "route.decided", data: { ...modern, runId: "legacy", pendingInteractionId: "legacy" } }, 0)).toMatchObject({ kind: "appended" });
  await makeRouter().ingest(ownerSender, ownerFacts);
  expect(commits).toHaveLength(1);
  expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
});

test("a changed decision refuses redelivery before committing or observing", async () => {
  const router = makeRouter();
  expect(await router.ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  registerOwnerDm(); createMappedOwnerSession();
  const count = routingDecisions().length;
  await expect(router.ingest(ownerSender, ownerFacts)).rejects.toMatchObject({ code: "route_replay_divergent" });
  expect(commits).toEqual([]);
  expect(routingDecisions()).toHaveLength(count);
  expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
});

test.each(["actorId", "trustTier", "inboundTreatment"] as const)("mutated %s authority refuses redelivery without leaking the authority", async (field) => {
  registerOwnerDm(); createMappedOwnerSession();
  const router = makeRouter();
  await router.ingest(ownerSender, ownerFacts);
  const count = routingDecisions().length;
  if (field === "actorId") {
    ActorRegistry.registerIdentity({ id: "replacement", kind: "human", trustTier: "owner" });
    ActorRegistry.registerEndpoint({ id: "endpoint-owner-dm", actorId: "replacement", channel: ownerSender.surface, externalId: ownerSender.externalId, workspace: ownerFacts.workspaceId });
  } else if (field === "trustTier") {
    ActorRegistry.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "manager" });
  } else {
    ChannelGrantStore.put({ id: "grant-owner-dm", surface: "discord", workspace: "owner-workspace", channel: "owner-dm", kind: "trusted_channel", inboundTreatment: "evidence_only", createdBy: "owner" });
  }
  let caught: Error | undefined;
  try { await router.ingest(ownerSender, ownerFacts); } catch (error) {
    if (!(error instanceof Error)) throw error;
    caught = error;
  }
  expect(caught).toMatchObject({ code: "route_replay_divergent" });
  for (const value of ["actor-owner", "replacement", "manager", "evidence_only"]) expect(caught?.message).not.toContain(value);
  expect(commits).toHaveLength(1);
  expect(routingDecisions()).toHaveLength(count);
});

test("equivalent blocked redelivery returns a refusal without another route fact", async () => {
  const router = makeRouter();
  for (let repeat = 0; repeat < 2; repeat += 1) expect(await router.ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
});

test.each(["append_failure", "absent", "missing_conflict", "corrupt_conflict"] as const)("ledger %s refuses before inbox commit or projection", async (fault) => {
  registerOwnerDm(); createMappedOwnerSession();
  const adapter = Storage.get();
  const ledger = adapter.ledger;
  if (ledger === undefined) throw new Error("missing ledger");
  Storage.configure({ ...adapter, transaction: adapter.transaction.bind(adapter), ledger: fault === "absent" ? undefined : {
    ...ledger,
    append: () => {
      if (fault === "append_failure") throw new Error("ledger unavailable");
      return { kind: "cas_conflict", currentHead: 1 };
    },
    headFact: () => fault === "corrupt_conflict" ? { streamId: streamId(), seq: 1, type: "route.decided", data: { invalid: true }, timeCreated: 1 } : undefined,
  } });
  await expect(makeRouter().ingest(ownerSender, ownerFacts)).rejects.toMatchObject({ code: "route_record_failed" });
  expect(commits).toEqual([]);
  expect(routingDecisions()).toEqual([]);
});

test("unconfigured actor delivery refuses without inbox commit", async () => {
  expect(await makeRouter().ingest({ kind: "session", id: "sender" }, { to: { kind: "actor", actorId: "target" }, type: "message", content: "hello" }))
    .toMatchObject({ status: "blocked_pre", reasonCode: "message.resident.actor_grant" });
  expect(commits).toEqual([]);
});

test("forged observations cannot choose a session", async () => {
  registerOwnerDm(); const mapped = createMappedOwnerSession();
  Bus.publish(Ingress.Events.RoutingDecision, {
    inboundId: ownerEvent.id, surface: ownerEvent.surface, stage: "surface_default", outcome: "route",
    sessionId: "forged", traceId: "trace", time: 1, reason: "forged", mode: "direct", factsUsed: [], target: "resident",
  });
  await makeRouter().ingest(ownerSender, ownerFacts);
  expect(commits).toHaveLength(1);
  expect(commits[0]?.sessionId).toBe(mapped.id);
  expect(Storage.get().ledger?.headFact(streamId())).toMatchObject({ seq: 1, data: { sessionId: mapped.id } });
});
