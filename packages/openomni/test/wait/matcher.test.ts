import { afterEach, describe, expect, test } from "bun:test";
import type { Dispatch, Ingress } from "@openomni/protocol";
import { ActorRegistry, Storage } from "@openomni/session";
import {
  dispatchEvidence,
  ingressEvidence,
  responderCandidates,
  targetsOfPendingInteraction,
  targetsOfWait,
} from "../../src/wait/index";
import { buildInteraction, buildWaitRecord, correlationFixture } from "../helpers/wait";

const correlation = Object.freeze({
  endpointId: correlationFixture.endpointId,
  channelId: correlationFixture.channelId,
  tokenHash: correlationFixture.tokenHash,
}) satisfies Dispatch.Correlation;

function directEvent(overrides: Partial<Ingress.DirectEvent> = {}): Ingress.DirectEvent {
  return {
    id: "inbound-1",
    surface: "telegram",
    mode: "direct",
    payload: "reply",
    meta: { correlation },
    agent: { model: { provider: "test", id: "test-model" } },
    ...overrides,
  };
}

function command(overrides: Partial<Dispatch.Command> = {}): Dispatch.Command {
  return {
    dispatchId: "dispatch-1",
    action: "actor.message",
    target: { kind: "surface", id: correlation.channelId },
    payload: "reply",
    correlation,
    actor: { kind: "unknown", actorId: "endpoint-1" },
    submittedAt: 1,
    ...overrides,
  };
}

describe("wait matcher — ingress evidence", () => {
  afterEach(() => {
    Storage.reset();
  });

  test("credits a bearer token only when no actor is pinned", () => {
    const bearer = buildInteraction("pi-bearer", {
      correlation: { tokenHash: correlation.tokenHash },
    });
    const pinned = buildInteraction("pi-pinned", {
      targetActorId: "actor-pinned",
      correlation: { tokenHash: correlation.tokenHash },
    });
    const evidence = ingressEvidence(directEvent(), correlation);

    expect(responderCandidates(targetsOfPendingInteraction(bearer), evidence)).toEqual([
      "endpoint-1",
    ]);
    expect(responderCandidates(targetsOfPendingInteraction(pinned), evidence)).toEqual([]);
  });

  test("rejects a claimed endpoint that contradicts the expected one", () => {
    const record = buildInteraction("pi-endpoint", { endpointId: "endpoint-2" });
    const evidence = ingressEvidence(directEvent(), { ...correlation, tokenHash: undefined });

    expect(responderCandidates(targetsOfPendingInteraction(record), evidence)).toEqual([]);
  });

  test("matches an identity-less direct sender through the userId endpoint forms", () => {
    const record = buildInteraction("pi-user", { endpointId: "telegram:seller-1" });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
    } satisfies Dispatch.Correlation;

    const suffixMatch = ingressEvidence(directEvent({ userId: "seller-1" }), claim);
    const mismatch = ingressEvidence(directEvent({ userId: "intruder-2" }), claim);

    expect(responderCandidates(targetsOfPendingInteraction(record), suffixMatch)).toEqual([
      "telegram:seller-1",
    ]);
    expect(responderCandidates(targetsOfPendingInteraction(record), mismatch)).toEqual([]);
  });

  test("requires resolved-actor endpoint evidence for a pinned target actor", () => {
    const record = buildInteraction("pi-actor", {
      targetActorId: "actor-a",
      endpointId: "telegram:seller-1",
    });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
    } satisfies Dispatch.Correlation;
    const withProof = directEvent({
      meta: {
        correlation: claim,
        actor: {
          actorId: "actor-a",
          endpoint: {
            id: "telegram:seller-1",
            actorId: "actor-a",
            channel: "telegram",
            externalId: "seller-1",
          },
        },
      },
    });
    const wrongActor = directEvent({
      meta: {
        correlation: claim,
        actor: {
          actorId: "actor-b",
          endpoint: {
            id: "telegram:seller-1",
            actorId: "actor-b",
            channel: "telegram",
            externalId: "seller-1",
          },
        },
      },
    });
    const wrongEndpoint = directEvent({
      meta: {
        correlation: claim,
        actor: {
          actorId: "actor-a",
          endpoint: {
            id: "telegram:other",
            actorId: "actor-a",
            channel: "telegram",
            externalId: "other-9",
          },
        },
      },
    });

    expect(
      responderCandidates(targetsOfPendingInteraction(record), ingressEvidence(withProof, claim)),
    ).toEqual(["actor-a"]);
    expect(
      responderCandidates(targetsOfPendingInteraction(record), ingressEvidence(wrongActor, claim)),
    ).toEqual([]);
    expect(
      responderCandidates(
        targetsOfPendingInteraction(record),
        ingressEvidence(wrongEndpoint, claim),
      ),
    ).toEqual([]);
  });

  test("pins the delivery endpoint only on the delivery-target responder", () => {
    // Registry-anchored: the wait's correlation.endpointId is the DELIVERY
    // endpoint; only the responder registered at it keeps the endpoint pin.
    Storage.initialize({ dbPath: ":memory:" });
    ActorRegistry.registerIdentity({
      id: "actor-target",
      kind: "ai_agent",
      trustTier: "collaborator",
      relationship: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-target",
      actorId: "actor-target",
      channel: "telegram",
      externalId: "target-1",
    });
    ActorRegistry.registerIdentity({
      id: "actor-r2",
      kind: "ai_agent",
      trustTier: "collaborator",
      relationship: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-r2",
      actorId: "actor-r2",
      channel: "telegram",
      externalId: "responder-2",
    });
    const record = buildWaitRecord("wait-delivery-pin", {
      correlation: { endpointId: "endpoint-target", channelId: correlation.channelId },
      expectedResponders: ["actor-target", "actor-r2"],
    });
    const evidenceFor = (actorId: string, endpointId: string, externalId: string) =>
      ingressEvidence(
        directEvent({
          meta: {
            correlation: { endpointId, channelId: correlation.channelId },
            actor: {
              actorId,
              endpoint: { id: endpointId, actorId, channel: "telegram", externalId },
            },
          },
        }),
        { endpointId, channelId: correlation.channelId },
      );

    // A non-delivery responder replying from their OWN endpoint matches on
    // resolved identity alone — the delivery pin no longer excludes them.
    expect(
      responderCandidates(
        targetsOfWait(record),
        evidenceFor("actor-r2", "endpoint-r2", "responder-2"),
      ),
    ).toEqual(["actor-r2"]);
    // The delivery-target responder still has to prove the delivery endpoint.
    expect(
      responderCandidates(
        targetsOfWait(record),
        evidenceFor("actor-target", "endpoint-target", "target-1"),
      ),
    ).toEqual(["actor-target"]);
    expect(
      responderCandidates(
        targetsOfWait(record),
        evidenceFor("actor-target", "endpoint-elsewhere", "elsewhere-9"),
      ),
    ).toEqual([]);
  });

  test("returns every credited expected responder of a wait row and never decides", () => {
    const record = buildWaitRecord("wait-quorum", {
      correlation: { channelId: correlation.channelId, threadId: "thread-1" },
      expectedResponders: ["actor-a", "actor-b", "actor-c"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
    });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
      threadId: "thread-1",
    } satisfies Dispatch.Correlation;
    const replyFromB = directEvent({
      meta: { correlation: claim, actor: { actorId: "actor-b" } },
    });
    const replyFromStranger = directEvent({
      meta: { correlation: claim, actor: { actorId: "actor-x" } },
    });

    expect(responderCandidates(targetsOfWait(record), ingressEvidence(replyFromB, claim))).toEqual([
      "actor-b",
    ]);
    expect(
      responderCandidates(targetsOfWait(record), ingressEvidence(replyFromStranger, claim)),
    ).toEqual([]);
  });
});

describe("wait matcher — dispatch evidence", () => {
  test("credits an unknown dispatch actor only when it presents the endpoint id itself", () => {
    const record = buildInteraction("pi-unknown", { correlation: {} });
    const presentsEndpoint = command({
      correlation: { endpointId: "endpoint-1", channelId: correlation.channelId },
      actor: { kind: "unknown", actorId: "endpoint-1" },
    });
    const other = command({
      correlation: { endpointId: "endpoint-1", channelId: correlation.channelId },
      actor: { kind: "unknown", actorId: "someone-else" },
    });

    expect(
      responderCandidates(targetsOfPendingInteraction(record), dispatchEvidence(presentsEndpoint)),
    ).toEqual(["endpoint-1"]);
    expect(
      responderCandidates(targetsOfPendingInteraction(record), dispatchEvidence(other)),
    ).toEqual([]);
  });

  test("never lets an unknown dispatch actor satisfy a pinned target actor", () => {
    const record = buildInteraction("pi-pinned-dispatch", {
      targetActorId: "actor-pinned",
      correlation: {},
    });
    const impersonator = command({
      correlation: { endpointId: "endpoint-1", channelId: correlation.channelId },
      actor: { kind: "unknown", actorId: "actor-pinned" },
    });

    expect(
      responderCandidates(targetsOfPendingInteraction(record), dispatchEvidence(impersonator)),
    ).toEqual([]);
  });

  test("matches a resolved dispatch actor against the pinned target actor", () => {
    const record = buildInteraction("pi-resolved-dispatch", {
      targetActorId: "actor-a",
      correlation: {},
    });
    const fromPinned = command({
      correlation: { endpointId: "endpoint-1", channelId: correlation.channelId },
      actor: { kind: "worker", actorId: "actor-a" },
    });
    const fromOther = command({
      correlation: { endpointId: "endpoint-1", channelId: correlation.channelId },
      actor: { kind: "worker", actorId: "actor-b" },
    });

    expect(
      responderCandidates(targetsOfPendingInteraction(record), dispatchEvidence(fromPinned)),
    ).toEqual(["actor-a"]);
    expect(
      responderCandidates(targetsOfPendingInteraction(record), dispatchEvidence(fromOther)),
    ).toEqual([]);
  });

  test("ignores a bearer token presented as a bare string correlation", () => {
    const record = buildInteraction("pi-string-token", {
      correlation: { tokenHash: correlation.tokenHash },
    });
    const stringCorrelation = command({
      correlation: correlation.tokenHash,
      actor: { kind: "unknown", actorId: "someone-else" },
    });

    expect(
      responderCandidates(targetsOfPendingInteraction(record), dispatchEvidence(stringCorrelation)),
    ).toEqual([]);
  });
});
