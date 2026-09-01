import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { BlacklistStore, ConversationStore, EgressBudgetStore, LeaseStore } from "@openomni/ledger";
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
    budgets: () => [],
    publish: Bus.publish,
  });
}

function openConversationAndLease(options: { maxOutbound?: number; leaseMax?: number } = {}): void {
  ConversationStore.open(
    {
      id: "conv:lease",
      contactId: "actor:target",
      endpointId: "endpoint:target",
      ownerRef: { kind: "session", id: "session:owner" },
      openedBy: "resident",
      policy: {
        expiresAt: messagingNow + 600_000,
        maxOutbound: options.maxOutbound ?? 4,
        maxInbound: 32,
        onInboundCapBreach: "demote",
      },
    },
    "trace-conv-open",
  );
  LeaseStore.issue(
    {
      id: "lease:1",
      conversationId: "conv:lease",
      holderDelegationId: "delegation-1",
      delegationDeadline: messagingNow + 300_000,
      maxOutbound: options.leaseMax ?? 2,
    },
    "trace-lease-issue",
  );
}

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

beforeEach(() => {
  resetStores();
  deliveries = [];
  grants = [];
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});

describe("lease send right", () => {
  test("a lease-pinned send debits both the lease and the conversation, stamped onBehalfOf/via", async () => {
    openConversationAndLease();
    const sent: Array<{ onBehalfOf?: string; via?: string; grantId: string }> = [];
    Bus.observe((event, data) => {
      if (event.name === "messaging.sent") {
        sent.push(data as { onBehalfOf?: string; via?: string; grantId: string });
      }
    });

    const receipt = await messaging().send(buildSendInput({ leaseId: "lease:1" }));

    expect(receipt).toMatchObject({ kind: "sent", grantId: "lease:lease:1" });
    expect(deliveries).toHaveLength(1);
    expect(LeaseStore.get("lease:1")?.budget.outboundUsed).toBe(1);
    expect(ConversationStore.get("conv:lease")?.outboundUsed).toBe(1);
    await flushBus();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      grantId: "lease:lease:1",
      onBehalfOf: "delegation-1",
      via: "lease:lease:1",
    });
  });

  test("a missing lease is denied lease_denied without delivery", async () => {
    const receipt = await messaging().send(buildSendInput({ leaseId: "lease:ghost" }));
    expect(receipt).toMatchObject({ kind: "denied", code: "lease_denied" });
    expect(deliveries).toHaveLength(0);
  });

  test("a conversation pin that mismatches the lease scope is denied", async () => {
    openConversationAndLease();
    const receipt = await messaging().send(
      buildSendInput({ leaseId: "lease:1", conversationId: "conv:other" }),
    );
    expect(receipt).toMatchObject({ kind: "denied", code: "lease_denied" });
    expect(deliveries).toHaveLength(0);
  });

  test("a spent lease refuses at the durable debit", async () => {
    openConversationAndLease({ leaseMax: 1 });

    const first = await messaging().send(buildSendInput({ leaseId: "lease:1" }));
    const second = await messaging().send(
      buildSendInput({ messageId: "message:test-2", leaseId: "lease:1" }),
    );

    expect(first.kind).toBe("sent");
    expect(second).toMatchObject({ kind: "denied", code: "lease_denied" });
    expect(deliveries).toHaveLength(1);
    expect(ConversationStore.get("conv:lease")?.outboundUsed).toBe(1);
  });

  test("a closed lease refuses the next send (revocation race, §8.6)", async () => {
    openConversationAndLease();
    LeaseStore.close("lease:1", "conversation_revoked", "trace-close");

    const receipt = await messaging().send(buildSendInput({ leaseId: "lease:1" }));

    expect(receipt).toMatchObject({ kind: "denied", code: "lease_denied" });
    expect(deliveries).toHaveLength(0);
    expect(ConversationStore.get("conv:lease")?.outboundUsed).toBe(0);
  });

  test("a lease send to a third party fails the conversation pin (§8.1)", async () => {
    openConversationAndLease();
    registerAgentFixture("actor:third", [{ id: "endpoint:third", externalId: "third-1" }]);

    const receipt = await messaging().send(
      buildSendInput({ target: { actorId: "actor:third" }, leaseId: "lease:1" }),
    );

    expect(receipt).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(0);
    expect(LeaseStore.get("lease:1")?.budget.outboundUsed).toBe(0);
  });

  test("the absolute blacklist deny still binds a lease send", async () => {
    openConversationAndLease();
    BlacklistStore.put({
      id: "bl:target",
      kind: "actor",
      value: "actor:target",
      createdBy: "actor:owner",
    });

    const receipt = await messaging().send(buildSendInput({ leaseId: "lease:1" }));

    expect(receipt).toMatchObject({ kind: "denied", code: "conversation_denied" });
    expect(deliveries).toHaveLength(0);
    expect(LeaseStore.get("lease:1")?.budget.outboundUsed).toBe(0);
  });

  test("a resumed send does not debit twice", async () => {
    openConversationAndLease();

    const first = await messaging().send(buildSendInput({ leaseId: "lease:1" }));
    const resumed = await messaging().send(buildSendInput({ leaseId: "lease:1" }));

    expect(first.kind).toBe("sent");
    expect(resumed.kind).toBe("sent");
    expect(LeaseStore.get("lease:1")?.budget.outboundUsed).toBe(1);
    expect(ConversationStore.get("conv:lease")?.outboundUsed).toBe(1);
  });

  test("the egress budget never counts a lease send", async () => {
    openConversationAndLease();
    let inspected = -1;
    const inspect = () => {
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
    };

    await messaging().send(buildSendInput({ leaseId: "lease:1" }));
    inspect();

    expect(inspected).toBe(0);
  });
});
