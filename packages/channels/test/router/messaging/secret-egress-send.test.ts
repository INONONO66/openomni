import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import {
  ConversationStore,
  EgressBudgetStore,
  LeaseStore,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  createExistingAgentMessaging,
  type MessagingPorts,
  type OutboundMessage,
} from "../../../src/router/messaging/send.js";
import {
  buildAwaitedSendInput,
  buildGrant,
  buildSendInput,
  messagingNow,
  registerAgentFixture,
} from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";

/**
 * #811 proactive egress gate. Every authority arm of the send kernel —
 * standing grant, awaited, conversation-pinned, lease-pinned, reply-scoped —
 * must refuse credential-shaped bodies BEFORE any durable side effect:
 * no admission fact, no budget/lease/conversation debit, no Wait row, no
 * delivery. The denial names the class and line only; the bytes never leave.
 */

const SECRET = "ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789";
const SECRET_BODY = `status update\ntoken ${SECRET} for the runner`;
const RENDER_ONLY_SECRET = "AKIAIOSFODNN7EXAMPLE";

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

let deliveries: OutboundMessage[];
let grants: Gateway.SenderTargetGrant[];
let deniedEvents: unknown[];

function messaging(overrides: Partial<MessagingPorts> = {}) {
  return createExistingAgentMessaging({
    deliver: (message) => {
      deliveries.push(message);
    },
    grants: () => grants,
    publish: Bus.publish,
    ...overrides,
  });
}

function admissionFact(messageId: string): unknown {
  const ledger = Storage.get().ledger;
  if (ledger === undefined) throw new Error("ledger sub-adapter missing");
  return ledger.headFact(`gateway_send:${encodeURIComponent(messageId)}`);
}

function egressDebitCount(): number {
  let count: number | undefined;
  EgressBudgetStore.claim(
    {
      id: "test:inspection-never-recorded",
      senderId: "actor:sender",
      targetActorId: "actor:target",
      class: "notify",
      at: messagingNow,
    },
    0,
    (state) => {
      count = state.countInWindow;
      return "inspect" as const;
    },
  );
  if (count === undefined) throw new Error("egress claim evaluator was not called");
  return count;
}

function expectNoDurableEffect(messageId: string): void {
  expect(deliveries).toEqual([]);
  expect(WaitStore.list()).toEqual([]);
  expect(admissionFact(messageId)).toBeUndefined();
  expect(egressDebitCount()).toBe(0);
}

/**
 * A budget that admits the send, so a clean-body test reaches `sent` and
 * proves the gate did not change the happy path. Denial-path tests keep the
 * empty source: #219's fail-safe would refuse them anyway, and the gate
 * running first is exactly what those tests pin.
 */
const permissiveBudget: () => readonly Gateway.SocialBudget[] = () => [
  {
    id: "budget:secret-egress",
    targetActorId: "actor:target",
    maxPerWindow: 10,
    windowMs: 60_000,
    cooldownMs: 0,
  },
];

function openConversation(id: string): string {
  ConversationStore.open(
    {
      id,
      contactId: "actor:target",
      endpointId: "endpoint:target",
      ownerRef: { kind: "session", id: "session:owner" },
      openedBy: "resident",
      policy: {
        expiresAt: messagingNow + 600_000,
        maxOutbound: 4,
        maxInbound: 32,
        onInboundCapBreach: "demote",
      },
    },
    "trace-conv-open",
  );
  return id;
}

beforeEach(() => {
  resetStores();
  deliveries = [];
  deniedEvents = [];
  grants = [buildGrant("grant:sender->target")];
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
  Bus.observe((event, payload) => {
    if (event.name === "messaging.denied") deniedEvents.push(payload);
  });
});

describe("proactive egress gate: authority arms", () => {
  test("Given a fire_and_forget send with a credential, When sent, Then it is denied secret_egress_denied with zero durable effect", async () => {
    const input = buildSendInput({ messageId: "message:secret-faf", body: SECRET_BODY });

    const receipt = await messaging({ budgets: () => [] }).send(input);

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
  });

  test("Given an awaited send with a credential, When sent, Then no Wait is opened and the denial is secret_egress_denied", async () => {
    const input = buildAwaitedSendInput({ messageId: "message:secret-awaited", body: SECRET_BODY });

    const receipt = await messaging({ budgets: () => [] }).send(input);

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
    expect(WaitStore.get("wait:test-awaited")).toBeUndefined();
  });

  test("Given a conversation-pinned send with a credential, When sent, Then the window is not debited", async () => {
    const conversationId = openConversation("conv:secret");
    const input = buildSendInput({
      messageId: "message:secret-conversation",
      body: SECRET_BODY,
      conversationId,
    });

    const receipt = await messaging({ budgets: () => [] }).send(input);

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
    expect(ConversationStore.get(conversationId)?.outboundUsed).toBe(0);
  });

  test("Given a lease-pinned send with a credential, When sent, Then neither lease nor conversation is debited", async () => {
    const conversationId = openConversation("conv:secret-lease");
    LeaseStore.issue(
      {
        id: "lease:secret",
        conversationId,
        holderDelegationId: "delegation-1",
        delegationDeadline: messagingNow + 300_000,
        maxOutbound: 2,
      },
      "trace-lease-issue",
    );
    const input = buildSendInput({
      messageId: "message:secret-lease",
      body: SECRET_BODY,
      leaseId: "lease:secret",
    });

    const receipt = await messaging({ budgets: () => [] }).send(input);

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
    expect(LeaseStore.get("lease:secret")?.budget.outboundUsed).toBe(0);
    expect(ConversationStore.get(conversationId)?.outboundUsed).toBe(0);
  });

  test("Given a reply-scoped send with a credential, When sent, Then the containment arm still denies secret_egress_denied", async () => {
    grants = [
      {
        id: "instance-reply",
        senderId: "actor:sender",
        targetActorId: "actor:target",
        operations: ["fire_and_forget"],
        expiresAt: messagingNow + 60_000,
        ruleId: "rule-1",
        replyScope: { surfaceKey: "qa:target-1" },
      },
    ];
    const input = buildSendInput({ messageId: "message:secret-reply", body: SECRET_BODY });

    const receipt = await messaging({ budgets: () => [] }).send(input);

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
  });
});

describe("proactive egress gate: rendered body and retries", () => {
  test("Given a body that only becomes credential-shaped after channel rendering, When sent, Then it is denied", async () => {
    const input = buildSendInput({
      messageId: "message:secret-rendered",
      // Benign as written; the channel renderer reassembles the credential.
      body: "aws key placeholder",
    });

    const receipt = await messaging({
      budgets: () => [],
      renderFor: () => (markdown) => markdown.replace("placeholder", RENDER_ONLY_SECRET),
    }).send(input);

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
  });

  test("Given a channel with no renderer, When a clean body is sent, Then the gate admits it unchanged", async () => {
    const input = buildSendInput({ messageId: "message:clean", body: "deploy finished" });

    const receipt = await messaging({ budgets: permissiveBudget, renderFor: () => undefined }).send(
      input,
    );

    expect(receipt.kind).toBe("sent");
    expect(deliveries.map((message) => message.body)).toEqual(["deploy finished"]);
  });

  test("Given a denied send retried under the same messageId, When resent, Then it is denied again with no admission", async () => {
    const input = buildSendInput({ messageId: "message:secret-retry", body: SECRET_BODY });
    const kernel = messaging({ budgets: () => [] });

    const first = await kernel.send(input);
    const second = await kernel.send(input);

    expect(first).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expect(second).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expectNoDurableEffect(input.messageId);
  });
});

describe("proactive egress gate: the denial carries no secret bytes", () => {
  test("Given a credential body, When denied, Then neither the receipt nor the messaging.denied event contains the secret", async () => {
    const input = buildSendInput({ messageId: "message:secret-audit", body: SECRET_BODY });

    const receipt = await messaging({ budgets: () => [] }).send(input);
    await flushBus();

    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.reason).toContain("provider_token");
    expect(receipt.reason).toContain("line 2");
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain("ghp_");
    expect(deniedEvents).toHaveLength(1);
    expect(JSON.stringify(deniedEvents)).not.toContain(SECRET);
    expect(JSON.stringify(deniedEvents)).not.toContain("ghp_");
  });

  test("Given a clean awaited send, When it runs, Then the gate leaves the happy path intact", async () => {
    const input = buildAwaitedSendInput({ body: "please confirm the rollout" });

    const receipt = await messaging({ budgets: permissiveBudget }).send(input);

    expect(receipt.kind).toBe("sent");
    expect(WaitStore.list()).toHaveLength(1);
  });
});
