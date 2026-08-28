import { describe, expect, test } from "bun:test";
import type { Communication } from "../../src/communication/index.js";
import type { Ingress } from "../../src/ingress/index.js";
import { Wait } from "../../src/wait/index.js";
import { buildWaitRecord } from "../helpers/wait.js";

const correlation = Object.freeze({
  endpointId: "endpoint-1",
  channelId: "channel-1",
  tokenHash: "token-1",
}) satisfies Wait.Correlation;

function buildInteraction(
  id: string,
  overrides: Partial<Communication.PendingInteraction.Record> = {},
): Communication.PendingInteraction.Record {
  return {
    id,
    workerRunId: `run-${id}`,
    sessionId: `session-${id}`,
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: {},
    allowedActions: ["report_result"],
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    followUpWindow: 0,
    ...overrides,
  };
}

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

describe("wait matcher — ingress evidence", () => {
  test("credits a bearer token only when no actor is pinned", () => {
    const bearer = buildInteraction("pi-bearer", {
      correlation: { tokenHash: correlation.tokenHash },
    });
    const pinned = buildInteraction("pi-pinned", {
      targetActorId: "actor-pinned",
      correlation: { tokenHash: correlation.tokenHash },
    });
    const evidence = Wait.ingressEvidence(directEvent(), correlation);

    expect(Wait.responderCandidates(Wait.targetsOfPendingInteraction(bearer), evidence)).toEqual([
      "endpoint-1",
    ]);
    expect(Wait.responderCandidates(Wait.targetsOfPendingInteraction(pinned), evidence)).toEqual(
      [],
    );
  });

  test("rejects a claimed endpoint that contradicts the expected one", () => {
    const record = buildInteraction("pi-endpoint", { endpointId: "endpoint-2" });
    const evidence = Wait.ingressEvidence(directEvent(), { ...correlation, tokenHash: undefined });

    expect(Wait.responderCandidates(Wait.targetsOfPendingInteraction(record), evidence)).toEqual(
      [],
    );
  });

  test("matches an identity-less direct sender through the userId endpoint forms", () => {
    const record = buildInteraction("pi-user", { endpointId: "telegram:seller-1" });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
    } satisfies Wait.Correlation;

    const suffixMatch = Wait.ingressEvidence(directEvent({ userId: "seller-1" }), claim);
    const mismatch = Wait.ingressEvidence(directEvent({ userId: "intruder-2" }), claim);

    expect(Wait.responderCandidates(Wait.targetsOfPendingInteraction(record), suffixMatch)).toEqual(
      ["telegram:seller-1"],
    );
    expect(Wait.responderCandidates(Wait.targetsOfPendingInteraction(record), mismatch)).toEqual(
      [],
    );
  });

  test("requires resolved-actor endpoint evidence for a pinned target actor", () => {
    const record = buildInteraction("pi-actor", {
      targetActorId: "actor-a",
      endpointId: "telegram:seller-1",
    });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
    } satisfies Wait.Correlation;
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
      Wait.responderCandidates(
        Wait.targetsOfPendingInteraction(record),
        Wait.ingressEvidence(withProof, claim),
      ),
    ).toEqual(["actor-a"]);
    expect(
      Wait.responderCandidates(
        Wait.targetsOfPendingInteraction(record),
        Wait.ingressEvidence(wrongActor, claim),
      ),
    ).toEqual([]);
    expect(
      Wait.responderCandidates(
        Wait.targetsOfPendingInteraction(record),
        Wait.ingressEvidence(wrongEndpoint, claim),
      ),
    ).toEqual([]);
  });

  test("pins the delivery endpoint only on the delivery-target responder", () => {
    // The wait's correlation.endpointId is the DELIVERY endpoint; only the
    // responder the caller resolved at it (registry-anchored, passed in as
    // the pure-core input) keeps the endpoint pin.
    const record = buildWaitRecord({
      id: "wait-delivery-pin",
      correlation: { endpointId: "endpoint-target", channelId: correlation.channelId },
      expectedResponders: ["actor-target", "actor-r2"],
      resolutionPolicy: "first_reply",
      quorum: undefined,
    });
    const targets = Wait.targetsOfWait(record, "actor-target");
    const evidenceFor = (actorId: string, endpointId: string, externalId: string) =>
      Wait.ingressEvidence(
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
      Wait.responderCandidates(targets, evidenceFor("actor-r2", "endpoint-r2", "responder-2")),
    ).toEqual(["actor-r2"]);
    // The delivery-target responder still has to prove the delivery endpoint.
    expect(
      Wait.responderCandidates(targets, evidenceFor("actor-target", "endpoint-target", "target-1")),
    ).toEqual(["actor-target"]);
    expect(
      Wait.responderCandidates(
        targets,
        evidenceFor("actor-target", "endpoint-elsewhere", "elsewhere-9"),
      ),
    ).toEqual([]);
  });

  test("fails closed when the delivery endpoint resolves to no actor", () => {
    // A pinned delivery endpoint whose registry resolution came back empty
    // (deliveryActorId undefined) yields NO targets, never a weaker unpinned
    // target set.
    const record = buildWaitRecord({
      id: "wait-unresolvable-delivery",
      correlation: { endpointId: "endpoint-gone", channelId: correlation.channelId },
      expectedResponders: ["actor-target"],
      resolutionPolicy: "first_reply",
      quorum: undefined,
    });

    expect(Wait.targetsOfWait(record, undefined)).toEqual([]);
  });

  test("returns every credited expected responder of a wait row and never decides", () => {
    const record = buildWaitRecord({
      id: "wait-quorum",
      correlation: { channelId: correlation.channelId, threadId: "thread-1" },
      expectedResponders: ["actor-a", "actor-b", "actor-c"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
    });
    const claim = {
      endpointId: "telegram:seller-1",
      channelId: correlation.channelId,
      threadId: "thread-1",
    } satisfies Wait.Correlation;
    const replyFromB = directEvent({
      meta: { correlation: claim, actor: { actorId: "actor-b" } },
    });
    const replyFromStranger = directEvent({
      meta: { correlation: claim, actor: { actorId: "actor-x" } },
    });

    expect(
      Wait.responderCandidates(
        Wait.targetsOfWait(record, undefined),
        Wait.ingressEvidence(replyFromB, claim),
      ),
    ).toEqual(["actor-b"]);
    expect(
      Wait.responderCandidates(
        Wait.targetsOfWait(record, undefined),
        Wait.ingressEvidence(replyFromStranger, claim),
      ),
    ).toEqual([]);
  });
});
