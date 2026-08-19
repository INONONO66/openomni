import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatAgentConfig, ChatAgentInput } from "@openomni/agent";
import { createGatewayRouter, type ChannelDeliveryRoute } from "@openomni/channels";
import {
  ActorRegistry,
  ChannelGrantStore,
  EngagementStore,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import {
  createBrainEngine,
  createEngagementTools,
  createMessageSendTool,
  createToolExecutor,
  ResidentRuntime,
} from "@openomni/openomni";
import type { Gateway, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

/**
 * #709 E2E — the 중고나라 origin scenario, composed exactly as bootstrap
 * wires it (real router + real brain engine + real tool executor built by the
 * agent's toolExecutorFactory, so engagementId/actorTrustTier ride the real
 * implicit-input seam from Gateway.Deliver all the way into the tools):
 *
 *   Owner: "sell the bike, floor 50000" → resident opens the engagement and
 *   sends an awaited as-me message to the marketplace actor (the wait's
 *   correlation carries the engagement) → the seller's reply correlates
 *   through the router → Deliver carries waitContext.engagementId → the run
 *   context hydrates the engagement slice with the resumed marker → the LLM
 *   reports a term crossing (offer below floor) → the machine FORCES
 *   awaiting_user_approval → a wait-resumption run cannot approve (no tier
 *   verdict) → an owner-tier inbound approves in-channel → acting → done.
 *   Plus: illegal transition refused; lazy deadline expiry at hydration.
 */

const PERSONA = "actor-persona";
const OWNER = "actor-owner";
const SELLER = "actor-buyer-kim";
const NOW = 5_000_000_000_000;

function registerActors(): void {
  ActorRegistry.registerIdentity({ id: PERSONA, kind: "ai_agent", trustTier: "owner" });
  ActorRegistry.registerIdentity({ id: OWNER, kind: "human", trustTier: "owner" });
  ActorRegistry.registerEndpoint({
    id: "telegram:owner-1",
    actorId: OWNER,
    channel: "telegram",
    externalId: "owner-1",
  });
  ActorRegistry.registerIdentity({ id: SELLER, kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: "telegram:buyer-kim",
    actorId: SELLER,
    channel: "telegram",
    externalId: "buyer-kim",
  });
  // The Owner's DM container is a trusted channel (full access); the buyer's
  // reply rides wait correlation, which needs no surface admission.
  ChannelGrantStore.put({
    id: "grant-telegram-owner-dm",
    surface: "telegram",
    channel: "telegram:owner-dm",
    kind: "trusted_channel",
    inboundTreatment: "full_access",
    createdBy: OWNER,
  });
}

function ownerInbound(id: string, text: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: `trace-${id}`,
    surface: "telegram",
    channel: "telegram:owner-dm",
    userId: "owner-1",
    mode: "direct",
    payload: text,
    meta: {},
  };
}

function buyerReply(id: string, replyToMessageId: string, text: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: `trace-${id}`,
    surface: "telegram",
    channel: "telegram:dm",
    userId: "buyer-kim",
    mode: "direct",
    payload: { action: "report_result", output: text },
    meta: {
      correlation: {
        endpointId: "telegram:buyer-kim",
        channelId: "telegram:dm",
        replyToMessageId,
      },
    },
  };
}

type ToolExecutorFn = (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
type RunScript = (toolExecutor: ToolExecutorFn, input: ChatAgentInput) => Promise<void>;

function composeHarness() {
  const outbound: Array<{ externalId: string; body: string }> = [];
  const deliveries: Gateway.Deliver[] = [];
  const runInputs: ChatAgentInput[] = [];
  const factoryContexts: Array<{ engagementId?: string; actorTrustTier?: string }> = [];
  const scripts: RunScript[] = [];

  // The exact bootstrap tool set: message.send (send seam + persona + the
  // sole-active-engagement fallback) + the engagement machine tools.
  const buildTools = () => [
    createMessageSendTool({
      send: (input) => router.messaging.send(input),
      personaActorId: PERSONA,
      now: () => NOW,
      activeEngagementId: (sessionId) => {
        const active = EngagementStore.list({
          ownerSessionId: sessionId,
          states: [...EngagementStore.activeStates],
        });
        const [sole, ...rest] = active;
        return rest.length === 0 ? sole?.id : undefined;
      },
    }),
    ...createEngagementTools({ engagements: EngagementStore, now: () => NOW }),
  ];

  const brain = createBrainEngine({
    residentRuntime: ResidentRuntime.create({
      runAgent: async (config: ChatAgentConfig, input: ChatAgentInput) => {
        runInputs.push(input);
        const script = scripts.shift();
        if (script) {
          if (config.toolExecutor === undefined) throw new Error("run without a tool executor");
          await script(config.toolExecutor, input);
        }
        return { text: "resident ran", finishReason: "stop" };
      },
    }),
    // The bridge shape (#707/#709): the resolver hands the brain an AgentDef
    // whose toolExecutorFactory builds the REAL executor from the run's
    // implicit context — engagementId/actorTrustTier included.
    externalAgentResolver: async () => ({
      model: { provider: "test", id: "test-model" },
      toolExecutorFactory: (ctx: {
        sessionId: string;
        runId: string;
        engagementId?: string;
        actorTrustTier?: string;
      }) => {
        factoryContexts.push({
          engagementId: ctx.engagementId,
          actorTrustTier: ctx.actorTrustTier,
        });
        return createToolExecutor({ tools: buildTools(), config: { runtime: ctx } });
      },
    }),
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
      grants: () => [
        {
          id: "grant-persona-buyer",
          senderId: PERSONA,
          targetActorId: SELLER,
          operations: ["awaited", "fire_and_forget"],
        },
      ],
    },
  });

  return { router, outbound, deliveries, runInputs, factoryContexts, scripts };
}

function parsedOutput(result: Tool.Result): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe("engagement machine — the 중고나라 scenario end to end (#709)", () => {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    registerActors();
  });

  test("open → awaited send → reply rehydrates → term crossing forces approval → owner approves → done", async () => {
    const harness = composeHarness();
    const captured: Record<string, Record<string, unknown>> = {};

    // ---- Run 1: the Owner delegates. The resident opens the engagement,
    // probes an illegal shortcut (typed rejection), sends the awaited as-me
    // message (engagement ownership via the sole-active fallback), and
    // records the awaiting_external edge with the opened wait.
    harness.scripts.push(async (tools, input) => {
      const context = { traceContext: input.traceContext };
      const opened = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.open",
          input: {
            title: "sell bike, floor 50000",
            terms: {
              spendCeiling: 50_000,
              autoApprove: "accept any offer at or above 50000",
              speakTriggers: ["direct question from the buyer"],
            },
          },
        },
        context,
      );
      captured.opened = parsedOutput(opened);
      const engagementId = captured.opened.id as string;

      // Illegal transition: planning → done has no edge.
      const illegal = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: { id: engagementId, to: "done", reason: "shortcut attempt" },
        },
        context,
      );
      captured.illegal = parsedOutput(illegal);

      const sent = await tools(
        {
          id: crypto.randomUUID(),
          tool: "message.send",
          input: {
            target: { actorId: SELLER },
            body: "자전거 아직 있습니다 — 5만원에 가져가실래요?",
            operation: "awaited",
            expectReply: { expiresInMs: 3_600_000 },
          },
        },
        context,
      );
      captured.sent = parsedOutput(sent);

      const awaiting = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: {
            id: engagementId,
            to: "awaiting_external",
            reason: "awaiting the buyer's answer",
            waitIds: [captured.sent.waitId as string],
          },
        },
        context,
      );
      captured.awaiting = parsedOutput(awaiting);
    });

    const delegated = await harness.router.ingest(
      ownerInbound("inbound-delegate", "자전거 팔아줘, 최소 5만원"),
    );
    if (delegated.kind === "dropped") throw new Error("owner delegation was dropped");
    const ownerSessionId = delegated.sessionId;
    if (ownerSessionId === undefined) throw new Error("owner delegation lost its session");

    // Owner-tier surface admission threaded the perimeter verdict into tools.
    expect(harness.deliveries[0]?.actorContext?.trustTier).toBe("owner");
    expect(harness.factoryContexts[0]).toEqual({
      engagementId: undefined,
      actorTrustTier: "owner",
    });

    const engagementId = captured.opened?.id as string;
    expect(captured.opened).toMatchObject({ state: "planning", title: "sell bike, floor 50000" });
    expect(captured.illegal).toMatchObject({ kind: "rejected", code: "illegal_transition" });
    expect(captured.sent).toMatchObject({ kind: "sent", operation: "awaited" });
    expect(captured.awaiting).toMatchObject({ kind: "transitioned", to: "awaiting_external" });

    // The wait row carries the engagement in its CORRELATION (ownership rides
    // resumption context; ownerRef stays the session — routing unchanged).
    const waitId = captured.sent?.waitId as string;
    expect(WaitStore.get(waitId)).toMatchObject({
      ownerRef: { kind: "session", id: ownerSessionId },
      correlation: { engagementId, replyToMessageId: "platform:1" },
    });
    expect(EngagementStore.get(engagementId)).toMatchObject({
      state: "awaiting_external",
      ownerSessionId,
      openWaitIds: [waitId],
    });

    // ---- Run 2: the buyer replies below the floor. Deliver must carry the
    // engagement; the run context must rehydrate it; the reported term
    // crossing must force the approval stop; and a wait-resumption run (no
    // tier verdict) must be unable to approve.
    harness.scripts.push(async (tools, input) => {
      const context = { traceContext: input.traceContext };
      const deliberate = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: { id: engagementId, to: "deliberating", reason: "buyer answered" },
        },
        context,
      );
      captured.deliberate = parsedOutput(deliberate);
      const crossing = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: {
            id: engagementId,
            to: "acting",
            reason: "buyer offers 45000 — below the 50000 floor",
            termCrossed: true,
          },
        },
        context,
      );
      captured.crossing = parsedOutput(crossing);
      // Non-owner approval attempt: this run resumes a wait — the delivery
      // carries NO actorContext, so the gate must refuse.
      const sneak = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: { id: engagementId, to: "acting", reason: "just do it" },
        },
        context,
      );
      captured.sneak = parsedOutput(sneak);
    });

    const replied = await harness.router.ingest(
      buyerReply("inbound-buyer-offer", "platform:1", "45000이면 바로 살게요"),
    );
    if (replied.kind === "dropped") throw new Error("buyer reply was dropped");
    expect(replied.sessionId).toBe(ownerSessionId);

    // Deliver carried the engagement resumption context end to end.
    const replyDelivery = harness.deliveries.at(-1);
    expect(replyDelivery?.waitContext).toMatchObject({
      waitId,
      allowedAction: "report_result",
      engagementId,
    });
    expect(replyDelivery?.actorContext).toBeUndefined();
    expect(harness.factoryContexts[1]).toEqual({ engagementId, actorTrustTier: undefined });

    // The engagement slice hydrated into the run context, resumed marker set.
    const replyRunContext = harness.runInputs[1]?.messages[0];
    expect(replyRunContext?.role).toBe("user");
    expect(replyRunContext?.content).toContain("[engagement context");
    expect(replyRunContext?.content).toContain("sell bike, floor 50000");
    expect(replyRunContext?.content).toContain("state: awaiting_external");
    expect(replyRunContext?.content).toContain("THIS DELIVERY RESUMES THIS ENGAGEMENT");
    expect(replyRunContext?.partMetadata).toEqual({ engagementContext: true });

    expect(captured.deliberate).toMatchObject({ kind: "transitioned", to: "deliberating" });
    expect(captured.crossing).toMatchObject({ kind: "forced_approval", requested: "acting" });
    expect(captured.sneak).toMatchObject({ kind: "rejected", code: "approval_required" });
    expect(EngagementStore.get(engagementId)?.state).toBe("awaiting_user_approval");

    // ---- Seed a second, already-overdue delegation: the next hydration must
    // expire it lazily (no sweeper) and keep it out of the active slice.
    EngagementStore.open(
      {
        id: "eng-overdue",
        ownerSessionId,
        title: "buy charger, ceiling 20000",
        terms: { deadline: Date.now() - 60_000 },
      },
      "trace-seed",
    );

    // ---- Run 3: the Owner approves in-channel (owner-tier surface
    // admission) → acting → done.
    harness.scripts.push(async (tools, input) => {
      const context = { traceContext: input.traceContext };
      const acting = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: { id: engagementId, to: "acting", reason: "owner approved 45000 in-channel" },
        },
        context,
      );
      captured.acting = parsedOutput(acting);
      const done = await tools(
        {
          id: crypto.randomUUID(),
          tool: "engagement.transition",
          input: { id: engagementId, to: "done", reason: "deal closed at 45000" },
        },
        context,
      );
      captured.done = parsedOutput(done);
    });

    const approved = await harness.router.ingest(ownerInbound("inbound-approve", "ㅇㅋ 진행해"));
    if (approved.kind === "dropped") throw new Error("owner approval was dropped");
    expect(approved.sessionId).toBe(ownerSessionId);
    expect(harness.factoryContexts[2]).toEqual({
      engagementId: undefined,
      actorTrustTier: "owner",
    });

    // Hydration listed the live delegation and expired the overdue one.
    const approvalRunContext = harness.runInputs[2]?.messages[0];
    expect(approvalRunContext?.content).toContain("state: awaiting_user_approval");
    expect(approvalRunContext?.content).not.toContain("buy charger");
    expect(EngagementStore.get("eng-overdue")?.state).toBe("expired");

    expect(captured.acting).toMatchObject({ kind: "transitioned", to: "acting" });
    expect(captured.done).toMatchObject({ kind: "transitioned", to: "done" });
    expect(EngagementStore.get(engagementId)).toMatchObject({ state: "done", openWaitIds: [] });
  });

  test("a session with no engagements hydrates no slice and message.send stamps nothing", async () => {
    const harness = composeHarness();
    let sendOutput: Record<string, unknown> | undefined;
    harness.scripts.push(async (tools, input) => {
      const sent = await tools(
        {
          id: crypto.randomUUID(),
          tool: "message.send",
          input: {
            target: { actorId: SELLER },
            body: "no delegation context here",
            operation: "awaited",
          },
        },
        { traceContext: input.traceContext },
      );
      sendOutput = parsedOutput(sent);
    });

    const result = await harness.router.ingest(ownerInbound("inbound-plain", "그냥 물어봐줘"));
    if (result.kind === "dropped") throw new Error("owner message was dropped");

    expect(
      harness.runInputs[0]?.messages.some((m) => m.content.includes("[engagement context")),
    ).toBe(false);
    expect(sendOutput).toMatchObject({ kind: "sent", operation: "awaited" });
    const wait = WaitStore.get(sendOutput?.waitId as string);
    expect(wait?.correlation.engagementId).toBeUndefined();
  });
});
