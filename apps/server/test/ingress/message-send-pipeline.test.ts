import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway, Tool } from "@openomni/protocol";
import { createGatewayRouter, type ChannelDeliveryRoute } from "@openomni/channels";
import {
  createBrainEngine,
  createMessageSendTool,
  createToolExecutor,
  ResidentRuntime,
} from "@openomni/openomni";
import { ActorRegistry, ChannelGrantStore, Session, Storage, WaitStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";

/**
 * #708 E2E — the as-me outbound trigger, composed exactly as bootstrap wires
 * it: resident agent invokes `message.send` (through the real tool executor,
 * so the calling session rides the implicit-input seam) → the gateway send
 * kernel grants/resolves/records → SendReceipt `sent` + durable Wait open →
 * a driver-shaped inbound reply from the expected responder correlates
 * through the router → brain deliver fires with waitContext → the calling
 * session is resumed. This closes the product-thesis "outbound as-me trigger
 * unwired" gap: the persona actor now has a live, grant-gated, ledgered path
 * from a resident run to an external counterpart and back.
 */

const PERSONA = "actor-persona";
const SELLER = "actor-seller";
const SELLER_ENDPOINT = "telegram:seller-1";
// Fixed injected clock, safely in the future of the real wall clock the wait
// fold reads (expiry is evaluated against Date.now() at reply time).
const NOW = 5_000_000_000_000;

function registerActors(): void {
  ActorRegistry.registerIdentity({ id: PERSONA, kind: "ai_agent", trustTier: "owner" });
  // A marketplace counterpart: admitted on the evidence tier (§2a) — enough
  // to correlate replies and to be a reply-grant initiator, never top-level
  // command authority.
  ActorRegistry.registerIdentity({ id: SELLER, kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: SELLER_ENDPOINT,
    actorId: SELLER,
    channel: "telegram",
    externalId: "seller-1",
  });
}

function sellerReply(id: string, replyToMessageId: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: "trace-reply",
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload: { action: "report_result", output: "yes, still available" },
    meta: {
      correlation: {
        endpointId: SELLER_ENDPOINT,
        channelId: "telegram:dm",
        replyToMessageId,
      },
    },
  };
}

function firstContactInbound(id: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: "trace-first-contact",
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload: "is the item still available?",
    meta: {},
  };
}

type Harness = ReturnType<typeof composeHarness>;

function composeHarness(config: {
  grants?: readonly Gateway.SenderTargetGrant[];
  replyGrantRules?: readonly Gateway.ReplyGrantRule[];
  personaActorId?: string | undefined;
  /**
   * Tool clock. Reply-grant tests use the real clock: instance materialization
   * stamps expiry with the router's wall clock at admission (Date.now at the
   * seam), and the evaluator compares it against the SEND's `at`.
   */
  now?: () => number;
}) {
  const outbound: Array<{ externalId: string; body: string }> = [];
  const deliveries: Gateway.Deliver[] = [];
  const residentRuns: string[] = [];

  const brain = createBrainEngine({
    residentRuntime: ResidentRuntime.create({
      runAgent: async () => {
        residentRuns.push("executed");
        return { text: "resident resumed", finishReason: "stop" };
      },
    }),
    externalAgentResolver: async () => ({ model: { provider: "test", id: "test-model" } }),
  });

  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>([
    [
      "telegram",
      async (externalId, body) => {
        outbound.push({ externalId, body });
        return { externalMessageId: `platform:${outbound.length}` };
      },
    ],
  ]);

  const router = createGatewayRouter({
    sink: Bus.publish,
    deliver: async (delivery) => {
      deliveries.push(delivery);
      return brain.deliver(delivery);
    },
    messaging: {
      deliveryRoutes,
      grants: () => config.grants ?? [],
      ...(config.replyGrantRules === undefined
        ? {}
        : { replyGrantRules: () => config.replyGrantRules ?? [] }),
    },
  });

  // The exact bootstrap construction: the tool holds the send seam and the
  // configured persona; the executor injects the calling session.
  const ownerSession = Session.create({
    traceId: "trace-e2e",
    title: "resident window",
    model: { providerID: "test", modelID: "test-model" },
  });
  const tool = createMessageSendTool({
    send: (input) => router.messaging.send(input),
    ...(config.personaActorId === undefined ? {} : { personaActorId: config.personaActorId }),
    now: config.now ?? (() => NOW),
  });
  const execute = createToolExecutor({
    tools: [tool],
    config: {
      runtime: { sessionId: ownerSession.id, runId: "run-resident-1", agentName: "resident" },
    },
  });

  async function invokeMessageSend(input: Record<string, unknown>): Promise<Tool.Result> {
    return execute(
      { id: crypto.randomUUID(), tool: "message.send", input },
      {
        traceContext: { traceId: "trace-e2e", sessionId: ownerSession.id, runId: "run-resident-1" },
      },
    );
  }

  return { router, ownerSession, outbound, deliveries, residentRuns, invokeMessageSend };
}

function outputOf(result: Tool.Result): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe("message.send → gateway → reply resumption (composed, #708)", () => {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    registerActors();
  });

  test("awaited as-me send with an Owner grant opens a Wait and the responder's reply resumes the calling session", async () => {
    const harness: Harness = composeHarness({
      personaActorId: PERSONA,
      grants: [
        {
          id: "grant-persona-seller",
          senderId: PERSONA,
          targetActorId: SELLER,
          operations: ["awaited", "fire_and_forget"],
        },
      ],
    });

    const result = await harness.invokeMessageSend({
      target: { actorId: SELLER },
      body: "Is the listing still available? I can pick it up today.",
      operation: "awaited",
      expectReply: { expiresInMs: 3_600_000 },
    });

    // 1) SendReceipt sent + Wait open, owned by the calling session.
    expect(result.isError).toBeUndefined();
    const output = outputOf(result);
    expect(output).toMatchObject({ kind: "sent", operation: "awaited" });
    const waitId = output.waitId as string;
    expect(harness.outbound).toEqual([
      { externalId: "seller-1", body: "Is the listing still available? I can pick it up today." },
    ]);
    const openWait = WaitStore.get(waitId);
    expect(openWait).toMatchObject({
      status: "open",
      ownerRef: { kind: "session", id: harness.ownerSession.id },
      expectedResponders: [SELLER],
      resolutionPolicy: "first_reply",
      expiresAt: NOW + 3_600_000,
      // Delivery receipt re-keyed correlation to the platform message id.
      correlation: { endpointId: SELLER_ENDPOINT, replyToMessageId: "platform:1" },
    });

    // 2) Driver-shaped reply from the expected responder correlates through
    //    the router and resumes the owner session with waitContext attached.
    const ingest = await harness.router.ingest(sellerReply("reply-1", "platform:1"));

    if (ingest.kind === "dropped") throw new Error("reply was dropped");
    expect(ingest.sessionId).toBe(harness.ownerSession.id);
    expect(ingest.result.output).toBe("resident resumed");
    expect(harness.residentRuns).toEqual(["executed"]);
    expect(WaitStore.get(waitId)).toMatchObject({ status: "resolved" });
    const resumed = harness.deliveries.at(-1);
    expect(resumed?.waitContext).toMatchObject({ waitId, allowedAction: "report_result" });
    expect(resumed?.sessionId).toBe(harness.ownerSession.id);
  });

  test("ungranted target: the agent sees the typed denial as a result and nothing is delivered or awaited", async () => {
    const harness = composeHarness({ personaActorId: PERSONA, grants: [] });

    const result = await harness.invokeMessageSend({
      target: { actorId: SELLER },
      body: "hello",
      operation: "awaited",
    });

    expect(result.isError).toBeUndefined();
    expect(outputOf(result)).toMatchObject({ kind: "denied", code: "ungranted" });
    expect(harness.outbound).toHaveLength(0);
    expect(WaitStore.list()).toHaveLength(0);
  });

  test("persona unset: the tool fails closed with a typed error result — no identity, no send", async () => {
    const harness = composeHarness({ personaActorId: undefined, grants: [] });

    const result = await harness.invokeMessageSend({
      target: { actorId: SELLER },
      body: "hello",
      operation: "fire_and_forget",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("persona not configured");
    expect(harness.outbound).toHaveLength(0);
  });

  test("reply-grant rule: a first-contact admission materializes a scoped instance that grants the reply and refuses cross-surface use", async () => {
    const harness = composeHarness({
      personaActorId: PERSONA,
      grants: [],
      now: Date.now,
      replyGrantRules: [
        {
          id: "rule-telegram-replies",
          senderId: PERSONA,
          surface: "telegram",
          operations: ["fire_and_forget", "awaited"],
          instanceTtlMs: 24 * 60 * 60 * 1000,
          maxLiveInstances: 5,
          createdBy: "actor-owner",
        },
      ],
    });
    // Surface-default admission requires an Owner channel grant (§2a); a
    // stranger-facing channel admits on the EVIDENCE tier, never full access.
    ChannelGrantStore.put({
      id: "grant-telegram-dm",
      surface: "telegram",
      channel: "telegram:dm",
      kind: "trusted_channel",
      inboundTreatment: "evidence_only",
      createdBy: "actor-owner",
    });

    // Before first contact: nothing materialized, the send is ungranted.
    const beforeContact = await harness.invokeMessageSend({
      target: { actorId: SELLER },
      body: "cold outreach",
      operation: "fire_and_forget",
    });
    expect(outputOf(beforeContact)).toMatchObject({ kind: "denied", code: "ungranted" });

    // First-contact inbound from the seller is admitted through the router →
    // the rule materializes ONE reply-scoped instance from perimeter facts.
    const admitted = await harness.router.ingest(firstContactInbound("inbound-first-contact"));
    if (admitted.kind === "dropped") throw new Error("first contact was dropped");

    // The reply INTO the initiating container is now granted…
    const reply = await harness.invokeMessageSend({
      target: { actorId: SELLER, endpointId: SELLER_ENDPOINT },
      body: "Yes — it is available. When suits you?",
      operation: "fire_and_forget",
    });
    expect(outputOf(reply)).toMatchObject({ kind: "sent", operation: "fire_and_forget" });
    expect(harness.outbound).toEqual([
      { externalId: "seller-1", body: "Yes — it is available. When suits you?" },
    ]);

    // …while the SAME instance is refused cross-surface (pinned containment).
    ActorRegistry.registerEndpoint({
      id: "discord:seller-9",
      actorId: SELLER,
      channel: "discord",
      externalId: "seller-9",
    });
    const crossSurface = await harness.invokeMessageSend({
      target: { actorId: SELLER, endpointId: "discord:seller-9" },
      body: "moving to discord",
      operation: "fire_and_forget",
    });
    const denied = outputOf(crossSurface);
    expect(denied).toMatchObject({ kind: "denied", code: "ungranted" });
    expect(String(denied.reason)).toContain("replies stay inside the initiating container");
    expect(harness.outbound).toHaveLength(1);
  });
});
