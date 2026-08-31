import { beforeEach, describe, expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { ConversationStore, Storage } from "@openomni/ledger";
import {
  createMappedOwnerSession,
  deliveries,
  makeRouter,
  ownerEvent,
  registerOwnerDm,
  resetRouterState,
} from "./_router-fixture";

function openConversation(overrides: { id?: string; inboundCapBreached?: boolean } = {}): string {
  const id = overrides.id ?? "conv-owner-dm";
  ConversationStore.open(
    {
      id,
      contactId: "actor-owner",
      endpointId: "endpoint-owner-dm",
      ownerRef: { kind: "session", id: "session-conv-owner" },
      openedBy: "resident",
      policy: {
        expiresAt: Date.now() + 60_000,
        maxOutbound: 8,
        maxInbound: 2,
        onInboundCapBreach: "demote",
      },
    },
    "trace-conv-open",
  );
  if (overrides.inboundCapBreached === true) {
    ConversationStore.recordInbound(id, "trace-pre-1");
    ConversationStore.recordInbound(id, "trace-pre-2");
    ConversationStore.recordInbound(id, "trace-pre-3");
  }
  return id;
}

describe("GatewayRouter conversation stage", () => {
  beforeEach(resetRouterState);

  test("an open conversation routes the inbound to the window owner's session", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const conversationId = openConversation();
    const router = makeRouter();

    await router.ingest(ownerEvent);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe("session-conv-owner");
    const fact = Storage.get().ledger?.headFact(Ingress.routeStreamId(ownerEvent));
    expect(fact).toMatchObject({
      type: "route.decided",
      data: {
        stage: "conversation",
        outcome: "route",
        conversationId,
        inboundTreatment: "full_access",
      },
    });
  });

  test("each routed delivery durably increments the inbound counter", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const conversationId = openConversation();
    const router = makeRouter();

    await router.ingest(ownerEvent);
    await router.ingest({ ...ownerEvent, id: "inbound-owner-dm-2" });

    expect(ConversationStore.get(conversationId)?.inboundUsed).toBe(2);
  });

  test("the first cap crossing publishes one owner wake and demotes the treatment", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const conversationId = openConversation({ inboundCapBreached: true });
    const router = makeRouter();

    await router.ingest({ ...ownerEvent, id: "inbound-owner-dm-3" });

    const record = ConversationStore.get(conversationId);
    expect(record?.state).toBe("open");
    expect(record?.inboundCapBreachedAt).toBeTypeOf("number");
    const fact = Storage.get().ledger?.headFact(
      Ingress.routeStreamId({ ...ownerEvent, id: "inbound-owner-dm-3" }),
    );
    expect(fact).toMatchObject({
      type: "route.decided",
      data: { stage: "conversation", inboundTreatment: "evidence_only" },
    });
  });

  test("a closed window falls through to the channel tier", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const conversationId = openConversation();
    ConversationStore.close(conversationId, "owner", "trace-conv-close");
    const router = makeRouter();

    await router.ingest(ownerEvent);

    expect(deliveries).toHaveLength(1);
    const fact = Storage.get().ledger?.headFact(Ingress.routeStreamId(ownerEvent));
    expect(fact).toMatchObject({ type: "route.decided", data: { stage: "surface_default" } });
  });

  test("no conversation on the endpoint leaves routing untouched", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const router = makeRouter();

    await router.ingest(ownerEvent);

    expect(deliveries).toHaveLength(1);
    const fact = Storage.get().ledger?.headFact(Ingress.routeStreamId(ownerEvent));
    expect(fact).toMatchObject({ type: "route.decided", data: { stage: "surface_default" } });
  });

  test("a conversation-routed delivery carries the wait settlement context", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    openConversation({ id: "conv:wait-42" });
    const router = makeRouter();

    await router.ingest(ownerEvent);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.waitContext).toEqual({
      waitId: "wait-42",
      allowedAction: "report_result",
    });
  });
});
