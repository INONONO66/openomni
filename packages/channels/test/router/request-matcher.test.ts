import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Ingress, SessionTransition } from "@openomni/protocol";
import { ActorRegistry, Storage } from "@openomni/ledger";
import * as Matcher from "../../src/router/request/matcher";

type ResponderTarget = Parameters<typeof Matcher.responderCandidates>[0][number];
import { requestFixture } from "../helpers/request-record";
beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

const correlation = Object.freeze({
  endpointId: "endpoint-1",
  channelId: "channel-1",
  tokenHash: "token-1",
}) satisfies SessionTransition.Correlation;

function directEvent(overrides: Partial<Ingress.DirectEvent> = {}): Ingress.DirectEvent {
  return {
    id: "inbound-1",
    traceId: "trace-test",
    surface: "telegram",
    mode: "direct",
    payload: "reply",
    meta: { correlation },
    agent: { model: { provider: "test", id: "test-model" } },
    ...overrides,
  };
}

describe("request matcher — ingress evidence", () => {
  test("credits a bearer token only when no actor is pinned", () => {
    const bearer: ResponderTarget = {
      responderId: "endpoint-1",
      endpointId: "endpoint-1",
      tokenHash: correlation.tokenHash,
    };
    const pinned: ResponderTarget = {
      responderId: "actor-pinned",
      targetActorId: "actor-pinned",
      endpointId: "endpoint-1",
      tokenHash: correlation.tokenHash,
    };
    const evidence = Matcher.ingressEvidence(directEvent(), correlation);

    expect(Matcher.responderCandidates([bearer], evidence)).toEqual(["endpoint-1"]);
    expect(Matcher.responderCandidates([pinned], evidence)).toEqual([]);
  });

  test("rejects a claimed endpoint that contradicts the expected one", () => {
    const target: ResponderTarget = { responderId: "endpoint-2", endpointId: "endpoint-2" };
    const evidence = Matcher.ingressEvidence(directEvent(), {
      ...correlation,
      tokenHash: undefined,
    });

    expect(Matcher.responderCandidates([target], evidence)).toEqual([]);
  });

  test("matches an identity-less direct sender through the userId endpoint forms", () => {
    const target: ResponderTarget = {
      responderId: "telegram:seller-1",
      endpointId: "telegram:seller-1",
    };
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
    } satisfies SessionTransition.Correlation;

    const suffixMatch = Matcher.ingressEvidence(directEvent({ userId: "seller-1" }), claim);
    const mismatch = Matcher.ingressEvidence(directEvent({ userId: "intruder-2" }), claim);

    expect(Matcher.responderCandidates([target], suffixMatch)).toEqual(["telegram:seller-1"]);
    expect(Matcher.responderCandidates([target], mismatch)).toEqual([]);
  });

  test("requires resolved-actor endpoint evidence for a pinned target actor", () => {
    const targets: ResponderTarget[] = [
      {
        responderId: "actor-a",
        targetActorId: "actor-a",
        endpointId: "telegram:seller-1",
      },
    ];
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
    } satisfies SessionTransition.Correlation;
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

    expect(Matcher.responderCandidates(targets, Matcher.ingressEvidence(withProof, claim))).toEqual(
      ["actor-a"],
    );
    expect(
      Matcher.responderCandidates(targets, Matcher.ingressEvidence(wrongActor, claim)),
    ).toEqual([]);
    expect(
      Matcher.responderCandidates(targets, Matcher.ingressEvidence(wrongEndpoint, claim)),
    ).toEqual([]);
  });

  test("pins the delivery endpoint only on the delivery-target responder", () => {
    // The request's correlation.endpointId is the DELIVERY endpoint; only the
    // responder the caller resolved at it (registry-anchored, passed in as
    // the pure-core input) keeps the endpoint pin.
    const record = requestFixture({
      requestId: "request-delivery-pin",
      correlation: { endpointId: "endpoint-target", channelId: correlation.channelId },
      expectedResponders: ["actor-target", "actor-r2"],
      resolution: "first",
    });
    ActorRegistry.registerIdentity({
      id: "actor-target",
      kind: "human",
      trustTier: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-target",
      actorId: "actor-target",
      channel: "telegram",
      externalId: "target-1",
    });
    const targets = Matcher.targetsOfRequest(record);
    const evidenceFor = (actorId: string, endpointId: string, externalId: string) =>
      Matcher.ingressEvidence(
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
      Matcher.responderCandidates(targets, evidenceFor("actor-r2", "endpoint-r2", "responder-2")),
    ).toEqual(["actor-r2"]);
    // The delivery-target responder still has to prove the delivery endpoint.
    expect(
      Matcher.responderCandidates(
        targets,
        evidenceFor("actor-target", "endpoint-target", "target-1"),
      ),
    ).toEqual(["actor-target"]);
    expect(
      Matcher.responderCandidates(
        targets,
        evidenceFor("actor-target", "endpoint-elsewhere", "elsewhere-9"),
      ),
    ).toEqual([]);
  });

  test("fails closed when the delivery endpoint resolves to no actor", () => {
    // A pinned delivery endpoint whose registry resolution came back empty
    // (deliveryActorId undefined) yields NO targets, never a weaker unpinned
    // target set.
    const record = requestFixture({
      requestId: "request-unresolvable-delivery",
      correlation: { endpointId: "endpoint-gone", channelId: correlation.channelId },
      expectedResponders: ["actor-target"],
      resolution: "first",
    });

    expect(Matcher.targetsOfRequest(record)).toEqual([]);
  });

  test("returns every credited expected responder of a request row and never decides", () => {
    const record = requestFixture({
      requestId: "request-quorum",
      correlation: { channelId: correlation.channelId, threadId: "thread-1" },
      expectedResponders: ["actor-a", "actor-b", "actor-c"],
      resolution: "quorum",
      threshold: 2,
    });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
      threadId: "thread-1",
    } satisfies SessionTransition.Correlation;
    const replyFromB = directEvent({
      meta: { correlation: claim, actor: { actorId: "actor-b" } },
    });
    const replyFromStranger = directEvent({
      meta: { correlation: claim, actor: { actorId: "actor-x" } },
    });

    expect(
      Matcher.responderCandidates(
        Matcher.targetsOfRequest(record),
        Matcher.ingressEvidence(replyFromB, claim),
      ),
    ).toEqual(["actor-b"]);
    expect(
      Matcher.responderCandidates(
        Matcher.targetsOfRequest(record),
        Matcher.ingressEvidence(replyFromStranger, claim),
      ),
    ).toEqual([]);
  });
});
