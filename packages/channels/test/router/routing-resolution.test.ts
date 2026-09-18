import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { rejected } from "../helpers/rejection";
import { replaceDecisionFacts } from "../helpers/ledger";
import { replyGrantEndpointFacts } from "../../src/router/messaging/reply-grant";
import { Channel, Ingress, type Gateway, type Inbox, type DecisionFact } from "@openomni/protocol";
import { messageExecutionReceipt } from "../helpers/message-execution";
import {
  ActorRegistry,
  ChannelGrantStore,
  SessionHandleStore,
  Storage,
  SurfaceKey,
} from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import {
  commits,
  createMappedOwnerSession,
  makeRouter,
  ownerEvent,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

const streamId = () => Ingress.routeStreamId(ownerEvent);
beforeEach(resetRouterState);

test("records the channel-scoped decision before inbox commit", async () => {
  registerOwnerDm();
  createMappedOwnerSession();
  const observed: Array<DecisionFact.Recorded | undefined> = [];
  const router = makeRouter({
    inbox: {
      commit: (row) => {
        observed.push(Storage.get().decisionFacts?.head(streamId()));
        return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
      },
    },
  });
  await router.ingest(ownerSender, ownerFacts);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ key: streamId(), type: "route.decided" });
});

test("blocked decisions are durable before returning the receipt", async () => {
  expect(await makeRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
    status: "blocked_pre",
  });
  expect(Storage.get().decisionFacts?.head(streamId())).toMatchObject({
    key: streamId(),
    type: "route.decided",
    data: { outcome: "block" },
  });
});

test("equivalent redelivery uses one route fact and the same inbox id", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  const router = makeRouter();
  await router.ingest(ownerSender, ownerFacts);
  const before = SessionHandleStore.tree(mapped.id);
  const recorded = Storage.get().decisionFacts?.head(streamId());
  await router.ingest(ownerSender, ownerFacts);
  expect(commits).toHaveLength(1);
  expect(SessionHandleStore.tree(mapped.id)).toEqual(before);
  expect(SessionHandleStore.inboxRows(mapped.id)).toHaveLength(1);
  expect(Storage.get().decisionFacts?.head(streamId())).toEqual(recorded);
});

test("historical route facts upcast on redelivery without reconstructing another route", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  await makeRouter().ingest(ownerSender, ownerFacts);
  const modern = Ingress.Events.RoutingDecision.schema.parse(
    Storage.get().decisionFacts?.head(streamId())?.data,
  );
  resetRouterState();
  registerOwnerDm();
  SurfaceKey.claim(
    Channel.SurfaceKey.fromChannel({
      surface: "discord",
      namespace: "owner-workspace",
      kind: "dm",
      id: "owner-dm",
    }),
    mapped.id,
  );
  const recorded = Storage.get().decisionFacts?.record({
    key: streamId(),
    type: "route.decided",
    data: { ...modern, runId: "legacy", pendingInteractionId: "legacy" },
    timeCreated: 1,
  });
  expect(recorded?.kind).toBe("recorded");
  await makeRouter().ingest(ownerSender, ownerFacts);
  expect(commits).toHaveLength(1);
  expect(Storage.get().decisionFacts?.head(streamId())).toEqual(recorded?.fact);
});

test("a changed decision refuses redelivery before committing or observing", async () => {
  const router = makeRouter();
  expect(await router.ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  registerOwnerDm();
  createMappedOwnerSession();
  const count = routingDecisions().length;
  const recorded = Storage.get().decisionFacts?.head(streamId());
  await expect(router.ingest(ownerSender, ownerFacts)).rejects.toMatchObject({
    code: "route_replay_divergent",
  });
  expect(commits).toEqual([]);
  expect(routingDecisions()).toHaveLength(count);
  expect(Storage.get().decisionFacts?.head(streamId())).toEqual(recorded);
});

test.each([
  "actorId",
  "trustTier",
  "inboundTreatment",
] as const)("mutated %s authority refuses redelivery without leaking the authority", async (field) => {
  registerOwnerDm();
  createMappedOwnerSession();
  const router = makeRouter();
  await router.ingest(ownerSender, ownerFacts);
  const count = routingDecisions().length;
  if (field === "actorId") {
    ActorRegistry.registerIdentity({ id: "replacement", kind: "human", trustTier: "owner" });
    ActorRegistry.registerEndpoint({
      id: "endpoint-owner-dm",
      actorId: "replacement",
      channel: ownerSender.surface,
      externalId: ownerSender.externalId,
      workspace: ownerFacts.workspaceId,
    });
  } else if (field === "trustTier") {
    ActorRegistry.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "manager" });
  } else {
    ChannelGrantStore.put({
      id: "grant-owner-dm",
      surface: "discord",
      workspace: "owner-workspace",
      channel: "owner-dm",
      kind: "trusted_channel",
      inboundTreatment: "evidence_only",
      createdBy: "owner",
    });
  }
  const caught = await rejected(router.ingest(ownerSender, ownerFacts), z.instanceof(Error));
  expect(caught).toMatchObject({ code: "route_replay_divergent" });
  for (const value of ["actor-owner", "replacement", "manager", "evidence_only"])
    expect(caught.message).not.toContain(value);
  expect(commits).toHaveLength(1);
  expect(routingDecisions()).toHaveLength(count);
});

test("a post-commit reply-grant failure retains commit progress for the executor receipt", async () => {
  registerOwnerDm();
  createMappedOwnerSession();
  const failure = new Error("reply grant projection failed");
  const observed: Gateway.MessageObservation[] = [];
  const notified: Inbox.Row[] = [];
  const router = makeRouter({
    observe: (_sender, observation) => observed.push(observation),
    committed: (row) => notified.push(row),
    messaging: {
      grants: () => [],
      deliveryRoutes: new Map(),
      replyGrantRules: () => {
        throw failure;
      },
    },
    run: async (_sender, request, body) => {
      await expect(body(messageExecutionReceipt("source", "ingress", request.intent))).rejects.toBe(
        failure,
      );
      return { terminal: "blocked_post", reason: "grant_projection_failed", matchedRuleIds: [] };
    },
  });
  expect(await router.ingest(ownerSender, ownerFacts)).toMatchObject({
    status: "blocked_post",
    reasonCode: "grant_projection_failed",
  });
  expect(commits).toHaveLength(1);
  expect(notified).toHaveLength(1);
  expect(observed.filter((observation) => observation.kind === "message.committed")).toHaveLength(
    1,
  );
});

test("reply endpoint changes reject an otherwise equivalent route replay", async () => {
  registerOwnerDm();
  createMappedOwnerSession();
  const router = makeRouter();
  await router.ingest(ownerSender, ownerFacts);
  const fact = Storage.get().decisionFacts?.head(streamId());
  if (fact === undefined) throw new Error("route fact missing");
  const original = Ingress.Events.RoutingDecision.schema.parse(fact.data);
  const priorEndpoint: readonly string[] = replyGrantEndpointFacts({
    channel: ownerSender.surface,
    externalId: ownerSender.externalId,
  });
  const changed = {
    ...original,
    factsUsed: [
      ...original.factsUsed.filter((value) => !priorEndpoint.includes(value)),
      ...replyGrantEndpointFacts({ channel: ownerSender.surface, externalId: "another-endpoint" }),
    ],
  };
  expect(Ingress.routeDecisionsEquivalent(original, changed)).toBe(true);
  replaceDecisionFacts((facts) => ({
    ...facts,
    record: (input) =>
      input.key === streamId()
        ? { kind: "exists", fact: { ...fact, data: changed } }
        : facts.record(input),
  }));
  await expect(router.ingest(ownerSender, ownerFacts)).rejects.toMatchObject({
    code: "route_replay_divergent",
  });
  expect(commits).toHaveLength(1);
  expect(routingDecisions()).toHaveLength(1);
});

test("equivalent blocked redelivery returns a refusal without another route fact", async () => {
  const router = makeRouter();
  expect(await router.ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  const recorded = Storage.get().decisionFacts?.head(streamId());
  expect(await router.ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  expect(Storage.get().decisionFacts?.head(streamId())).toEqual(recorded);
});

test.each([
  "record_failure",
  "absent",
  "wrong_type",
  "corrupt_fact",
] as const)("decision facts %s refuses before inbox commit or projection", async (fault) => {
  registerOwnerDm();
  createMappedOwnerSession();
  replaceDecisionFacts((facts) =>
    fault === "absent"
      ? undefined
      : {
          ...facts,
          record: () => {
            if (fault === "record_failure") throw new Error("decision facts unavailable");
            return {
              kind: "exists",
              fact: {
                key: streamId(),
                type: fault === "wrong_type" ? "other.fact" : "route.decided",
                data: { invalid: true },
                timeCreated: 1,
                rowHash: "0".repeat(64),
              },
            };
          },
        },
  );
  await expect(makeRouter().ingest(ownerSender, ownerFacts)).rejects.toMatchObject({
    code: "route_record_failed",
  });
  expect(commits).toEqual([]);
  expect(routingDecisions()).toEqual([]);
});

test("unconfigured actor delivery refuses without inbox commit", async () => {
  expect(
    await makeRouter().ingest(
      { kind: "session", id: "sender" },
      { to: { kind: "actor", actorId: "target" }, type: "message", content: "hello" },
    ),
  ).toMatchObject({ status: "blocked_pre", reasonCode: "message.resident.actor_grant" });
  expect(commits).toEqual([]);
});

test("forged observations cannot choose a session", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  Bus.publish(Ingress.Events.RoutingDecision, {
    inboundId: ownerEvent.id,
    surface: ownerEvent.surface,
    stage: "surface_default",
    outcome: "route",
    sessionId: "forged",
    traceId: "trace",
    time: 1,
    reason: "forged",
    mode: "direct",
    factsUsed: [],
    target: "resident",
  });
  await makeRouter().ingest(ownerSender, ownerFacts);
  expect(commits).toHaveLength(1);
  expect(commits[0]?.sessionId).toBe(mapped.id);
  expect(Storage.get().decisionFacts?.head(streamId())).toMatchObject({
    key: streamId(),
    data: { sessionId: mapped.id },
  });
});
