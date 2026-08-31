import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { BlacklistStore, ConversationStore, EgressBudgetStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  createExistingAgentMessaging,
  type OutboundMessage,
} from "../../../src/router/messaging/send.js";
import { buildSendInput, messagingNow, registerAgentFixture } from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";

type SenderTargetGrant = Gateway.SenderTargetGrant;

let deliveries: OutboundMessage[];
let grants: SenderTargetGrant[];

function messaging() {
  return createExistingAgentMessaging({
    deliver: (message) => {
      deliveries.push(message);
    },
    grants: () => grants,
    // Budgets wired to prove the conversational arm never touches them.
    budgets: () => [],
    publish: Bus.publish,
  });
}

function openConversation(overrides: { maxOutbound?: number; expiresAt?: number } = {}): string {
  ConversationStore.open(
    {
      id: "conv:send",
      contactId: "actor:target",
      endpointId: "endpoint:target",
      ownerRef: { kind: "session", id: "session:owner" },
      openedBy: "resident",
      policy: {
        expiresAt: overrides.expiresAt ?? messagingNow + 600_000,
        maxOutbound: overrides.maxOutbound ?? 2,
        maxInbound: 32,
        onInboundCapBreach: "demote",
      },
    },
    "trace-conv-open",
  );
  return "conv:send";
}

beforeEach(() => {
  resetStores();
  deliveries = [];
  grants = [];
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});

describe("conversational send right", () => {
  test("a conversation-pinned send bypasses grants and budgets and debits the window", async () => {
    openConversation();

    const receipt = await messaging().send(buildSendInput({ conversationId: "conv:send" }));

    expect(receipt).toMatchObject({ kind: "sent", grantId: "conversation:conv:send" });
    expect(deliveries).toHaveLength(1);
    expect(ConversationStore.get("conv:send")?.outboundUsed).toBe(1);
  });

  test("a conversation-pinned send is denied when the window is missing, closed, or expired", async () => {
    const missing = await messaging().send(buildSendInput({ conversationId: "conv:ghost" }));
    expect(missing).toMatchObject({ kind: "denied", code: "conversation_denied" });

    openConversation();
    ConversationStore.close("conv:send", "owner", "trace-close");
    const closed = await messaging().send(buildSendInput({ conversationId: "conv:send" }));
    expect(closed).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(0);
  });

  test("an expired window refuses at the durable debit even when the read raced", async () => {
    openConversation({ expiresAt: messagingNow - 1 });

    const receipt = await messaging().send(buildSendInput({ conversationId: "conv:send" }));

    expect(receipt).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(0);
  });

  test("the outbound cap refuses the send past the window bound", async () => {
    openConversation({ maxOutbound: 1 });

    const first = await messaging().send(buildSendInput({ conversationId: "conv:send" }));
    const second = await messaging().send(
      buildSendInput({ messageId: "message:test-2", conversationId: "conv:send" }),
    );

    expect(first.kind).toBe("sent");
    expect(second).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(1);
    expect(ConversationStore.get("conv:send")?.outboundUsed).toBe(1);
  });

  test("a window pinned to another actor or endpoint refuses the send", async () => {
    openConversation();
    registerAgentFixture("actor:other", [{ id: "endpoint:other", externalId: "other-1" }]);

    const wrongActor = await messaging().send(
      buildSendInput({ target: { actorId: "actor:other" }, conversationId: "conv:send" }),
    );
    expect(wrongActor).toMatchObject({ kind: "denied", code: "conversation_denied" });

    registerAgentFixture("actor:target", [{ id: "endpoint:target-2", externalId: "target-2" }]);
    const wrongEndpoint = await messaging().send(
      buildSendInput({
        target: { actorId: "actor:target", endpointId: "endpoint:target-2" },
        conversationId: "conv:send",
      }),
    );
    expect(wrongEndpoint).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(0);
  });

  test("the absolute blacklist deny still binds a conversation-pinned send", async () => {
    openConversation();
    BlacklistStore.put({
      id: "bl:target",
      kind: "actor",
      value: "actor:target",
      createdBy: "actor:owner",
    });

    const receipt = await messaging().send(buildSendInput({ conversationId: "conv:send" }));

    expect(receipt).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(0);
    expect(ConversationStore.get("conv:send")?.outboundUsed).toBe(0);
  });

  test("a resumed send does not debit the window twice", async () => {
    openConversation();

    const first = await messaging().send(buildSendInput({ conversationId: "conv:send" }));
    const resumed = await messaging().send(buildSendInput({ conversationId: "conv:send" }));

    expect(first.kind).toBe("sent");
    expect(resumed.kind).toBe("sent");
    expect(ConversationStore.get("conv:send")?.outboundUsed).toBe(1);
  });

  test("the egress budget never counts a conversation-pinned send", async () => {
    openConversation();
    let inspected = 0;
    EgressBudgetStore.claim(
      {
        id: "test:inspection",
        senderId: "actor:sender",
        targetActorId: "actor:target",
        class: "notify",
        at: messagingNow,
      },
      0,
      (state) => {
        inspected = state.countInWindow;
        return "inspect" as const;
      },
    );
    expect(inspected).toBe(0);

    await messaging().send(buildSendInput({ conversationId: "conv:send" }));

    EgressBudgetStore.claim(
      {
        id: "test:inspection",
        senderId: "actor:sender",
        targetActorId: "actor:target",
        class: "notify",
        at: messagingNow,
      },
      0,
      (state) => {
        inspected = state.countInWindow;
        return "inspect" as const;
      },
    );
    expect(inspected).toBe(0);
  });
});
