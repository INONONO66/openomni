import { afterEach, describe, expect, it } from "bun:test";
import { IngressEvent } from "@openomni/protocol";
import { resolveRoute, type RouteInbound, type RouteState } from "../../src/ingress/index";
import { IngressEventProjector } from "../../src/ingress/event-projector";
import { IngressHandlers } from "../../src/ingress/handlers";
import { SessionBridge } from "../../src/ingress/session-bridge";
import type { AuthorityProjectionQueryPort } from "../../src/ingress/actor-resolver";
import { resolveKernelRoute } from "../../src/ingress/routing-runtime";
import type { WaitKernelService } from "../../src/ingress/wait-correlation";
import {
  type MessagingLedgerService,
  type ResidentIngressReceipt,
  configureMessagingLedgerService,
} from "../../src/ingress/session-resolver";

function parseDecision(inbound: RouteInbound, state: RouteState) {
  const decision = resolveRoute(inbound, state);
  return IngressEvent.RoutingDecision.schema.parse(decision);
}

describe("resolveRoute", () => {
  it("returns one surface route for a registered Owner DM", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-owner-dm",
      time: 1_000,
      id: "inbound-owner-dm",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-owner-dm",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
        defaultTier: "owner",
      }),
      actor: Object.freeze({
        id: "actor-owner",
        trustTier: "owner",
        registered: true,
      }),
      surfaceSessionId: "session-owner-dm",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-owner-dm",
      time: 1_000,
      inboundId: "inbound-owner-dm",
      surface: "discord",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-owner-dm",
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
    expect(decision.factsUsed).toContain("channel:grant-owner-dm");
    expect(decision.factsUsed).toContain("actor:actor-owner");
    expect(decision.factsUsed).toContain("surface.default:session-owner-dm");
  });

  it("routes trusted first contact to a new surface session candidate", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-first-contact",
      time: 1_500,
      id: "inbound-first-contact",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-first-contact",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
        defaultTier: "owner",
      }),
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-first-contact",
      time: 1_500,
      inboundId: "inbound-first-contact",
      surface: "discord",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
    expect(decision.sessionId).toBeUndefined();
    expect(decision.factsUsed).toContain("surface.default:new");
    expect(decision.factsUsed.some((fact) => fact.includes("undefined"))).toBe(false);
  });

  it("routes an allowed report reply to its PendingInteraction session and run", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-report-reply",
      time: 2_000,
      id: "inbound-report-reply",
      surface: "app_connector",
      mode: "direct",
      target: "resident",
      requestedAction: "report_result",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({
        kind: "match",
        backing: "pending_interaction",
        key: "pending_interaction:interaction-report",
        recordId: "interaction-report",
        sessionId: "session-owning-work",
        runId: "run-owning-work",
        allowed: Object.freeze(["report_result"]),
        targetActorId: "actor-external-worker",
      }),
      channel: Object.freeze({
        id: "blocked-decoy",
        kind: "blocked_channel",
        inboundTreatment: "drop",
      }),
      surfaceSessionId: "session-surface-decoy",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-report-reply",
      time: 2_000,
      inboundId: "inbound-report-reply",
      surface: "app_connector",
      mode: "direct",
      stage: "wait_correlation",
      outcome: "route",
      target: "worker-session:session-owning-work",
      sessionId: "session-owning-work",
      runId: "run-owning-work",
      pendingInteractionId: "interaction-report",
      actorId: "actor-external-worker",
      trustTier: "assigned_worker",
    });
    expect(decision.factsUsed).toContain("wait:pending_interaction:interaction-report");
    expect(decision.factsUsed).toContain("wait.action:report_result");
  });

  it("routes a PendingAsk match to its owning Resident session and optional run", () => {
    const inbound = Object.freeze({
      traceId: "trace-pending-ask",
      time: 2_500,
      id: "inbound-pending-ask",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({
        kind: "match",
        backing: "pending_ask",
        key: "pending_ask:ask-owner",
        recordId: "ask-owner",
        sessionId: "session-ask-owner",
        runId: "run-ask-owner",
      }),
      channel: Object.freeze({
        id: "blocked-decoy",
        kind: "blocked_channel",
        inboundTreatment: "drop",
      }),
      surfaceSessionId: "session-surface-decoy",
    }) satisfies RouteState;

    const decision = parseDecision(inbound, state);

    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: "session-ask-owner",
      runId: "run-ask-owner",
    });
    expect(decision.pendingInteractionId).toBeUndefined();
    expect(decision.trustTier).toBeUndefined();
    expect(decision.factsUsed).toContain("wait:pending_ask:ask-owner");
  });

  it("routes system cron through the same surface-default decision", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-cron",
      time: 3_000,
      id: "inbound-cron",
      surface: "cron",
      mode: "internal",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      surfaceSessionId: "session-cron",
      systemActorId: "system:cron",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-cron",
      time: 3_000,
      inboundId: "inbound-cron",
      surface: "cron",
      mode: "internal",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-cron",
      actorId: "system:cron",
    });
    expect(decision.factsUsed).toContain("actor.system:system:cron");
    expect(decision.factsUsed).toContain("surface.default:session-cron");
  });
});

describe("resolveKernelRoute", () => {
  it("drives the retained Wait and authority query ports before selecting a route", async () => {
    const queryOrder: string[] = [];
    const refs = {
      sourceEventId: "authority-event-pipeline",
      sourceOwnerSeq: 1,
      sourceLedgerSeq: 2,
      sourceOwnerHash: "d".repeat(64),
      asOfLedgerSeq: 2,
    } as const;
    const authorityQueries: AuthorityProjectionQueryPort = {
      async query(request) {
        queryOrder.push(request.kind);
        if (request.kind === "authority.blacklist_match") {
          return { ...refs, kind: request.kind, entry: null };
        }
        if (request.kind === "authority.channel_grant") {
          return {
            ...refs,
            kind: request.kind,
            grant: {
              id: "grant-runtime",
              surface: "discord",
              channel: "owner-dm",
              kind: "trusted_channel",
              createdBy: "actor-owner",
            },
          };
        }
        if (request.kind === "authority.actor_by_endpoint") {
          return {
            ...refs,
            kind: request.kind,
            endpointSourceRefs: refs,
            identitySourceRefs: refs,
            identity: null,
            endpoint: null,
          };
        }
        return { ...refs, kind: request.kind, grant: null };
      },
    };
    const waits: WaitKernelService = {
      async correlate() {
        queryOrder.push("wait.correlate");
        return { kind: "none", candidates: [] };
      },
      async revalidatePinned() {
        return { kind: "invalid", reason: "not used" };
      },
      async acceptResponse() {
        throw new Error("not used");
      },
      async settle() {
        throw new Error("not used");
      },
      async cancel() {
        return undefined;
      },
      async stageAmbiguity() {
        return undefined;
      },
      async markRouted() {
        return undefined;
      },
    };
    const event = {
      id: "inbound-runtime-route",
      surface: "discord",
      channel: "owner-dm",
      mode: "direct" as const,
      payload: "hello",
      meta: { actor: { actorId: "actor-owner", trustTier: "owner" as const } },
      runtime: { durableSessionId: "session-runtime" },
      agent: { model: { provider: "test", id: "fixture" } },
    };

    const resolution = await resolveKernelRoute(event, "trace-runtime", {
      authorityQueries,
      waits,
    });

    expect(queryOrder).toEqual([
      "wait.correlate",
      "authority.blacklist_match",
      "authority.channel_grant",
    ]);
    expect(resolution.decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      actorId: "actor-owner",
      trustTier: "owner",
      sessionId: "session-runtime",
    });
    expect(resolution.event.meta).toMatchObject({
      channelGrantId: "grant-runtime",
      inboundTreatment: "full_access",
    });
  });
});

describe("atomic Resident ingress", () => {
  afterEach(() => configureMessagingLedgerService(undefined));

  it("replays first-contact RT-12 with deterministic IDs and one durable message", async () => {
    let surfaceSessionId: string | null = null;
    let transcriptCount = 0;
    const receipts = new Map<string, ResidentIngressReceipt>();
    const transitions: string[] = [];
    const service: MessagingLedgerService = {
      async execute(command) {
        transitions.push(command.kind);
        if (command.kind === "RT-11" || command.kind === "RT-12") {
          const existing = receipts.get(command.requestId);
          if (existing) return { status: "committed", residentReceipt: existing };
          surfaceSessionId = command.sessionId;
          transcriptCount += 1;
          const receipt: ResidentIngressReceipt = {
            requestId: command.requestId,
            sessionId: command.sessionId,
            messageId: command.messageId,
            partId: command.partId,
            effectId: command.effectId,
            isNewSession: command.kind === "RT-12",
          };
          receipts.set(command.requestId, receipt);
          return { status: "committed", residentReceipt: receipt };
        }
        if (command.kind === "EF-01" || command.kind === "EF-02" || command.kind === "EF-03") {
          const receipt = [...receipts.values()].find(
            (value) => value.effectId === command.effectId,
          );
          if (!receipt) return { status: "rejected", code: "not_found" };
          receipts.set(receipt.requestId, { ...receipt, outcome: command.outcome });
          return { status: "committed" };
        }
        return { status: "rejected", code: "transition_forbidden" };
      },
      async query(request) {
        if (request.kind === "surface") return { kind: "surface", sessionId: surfaceSessionId };
        if (request.kind === "session") return { kind: "session", session: null };
        return { kind: "transcript", messages: [] };
      },
    };
    configureMessagingLedgerService(service);
    const event = {
      id: "authenticated-delivery-42",
      surface: "discord",
      payload: "hello",
      mode: "direct" as const,
      meta: { target: { kind: "resident" as const } },
      agent: { model: { provider: "test", id: "fixture" } },
    };
    const model = { providerID: "test", modelID: "fixture" };

    const first = await IngressEventProjector.projectResident(event, "discord::", model);
    const replay = await IngressEventProjector.projectResident(event, "discord::", model);
    const followUp = await IngressEventProjector.projectResident(
      { ...event, id: "authenticated-delivery-43", payload: "follow up" },
      "discord::",
      model,
    );

    expect(replay).toEqual(first);
    expect(transcriptCount).toBe(2);
    expect(transitions).toEqual(["RT-12", "RT-12", "RT-11"]);
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(first.messageId).toMatch(/^message:[0-9a-f]{64}$/);
    expect(first.partId).toMatch(/^part:[0-9a-f]{64}$/);
  });

  it("preserves every canonical text part in transcript order", async () => {
    const service: MessagingLedgerService = {
      async execute() {
        return { status: "rejected", code: "transition_forbidden" };
      },
      async query(request) {
        if (request.kind === "surface") return { kind: "surface", sessionId: null };
        if (request.kind === "session") return { kind: "session", session: null };
        return {
          kind: "transcript",
          messages: [
            {
              role: "user",
              parts: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
              ],
            },
            { role: "assistant", parts: [{ type: "text", text: "third" }] },
          ],
        };
      },
    };
    configureMessagingLedgerService(service);

    await expect(SessionBridge.buildDirectMessages("session-1")).resolves.toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "third" },
    ]);
  });

  it("returns a settled Resident outcome on replay without a pending effect", async () => {
    let receipt: ResidentIngressReceipt | undefined;
    const service: MessagingLedgerService = {
      async execute(command) {
        if (command.kind === "RT-11" || command.kind === "RT-12") {
          receipt ??= {
            requestId: command.requestId,
            sessionId: command.sessionId,
            messageId: command.messageId,
            partId: command.partId,
            effectId: command.effectId,
            isNewSession: true,
          };
          return { status: "committed", residentReceipt: receipt };
        }
        if (command.kind === "EF-01" || command.kind === "EF-02" || command.kind === "EF-03") {
          if (!receipt) return { status: "rejected", code: "not_found" };
          receipt = { ...receipt, outcome: command.outcome };
          return { status: "committed" };
        }
        return { status: "rejected", code: "transition_forbidden" };
      },
      async query(request) {
        if (request.kind === "surface") {
          return { kind: "surface", sessionId: receipt?.sessionId ?? null };
        }
        if (request.kind === "session") return { kind: "session", session: null };
        return { kind: "transcript", messages: [] };
      },
    };
    configureMessagingLedgerService(service);
    const event = {
      id: "authenticated-delivery-settlement",
      surface: "discord",
      payload: "hello",
      mode: "direct" as const,
      meta: { target: { kind: "resident" as const } },
      agent: { model: { provider: "test", id: "fixture" } },
    };
    const model = { providerID: "test", modelID: "fixture" };
    const pending = await IngressEventProjector.projectResident(event, "discord::", model);
    const result = {
      mode: "direct" as const,
      target: { kind: "resident" as const },
      sessionId: pending.sessionId,
      result: { output: "done", finishReason: "stop" },
    };

    await IngressEventProjector.settleResident(pending, event.id, { status: "confirmed", result });
    const replay = await IngressEventProjector.projectResident(event, "discord::", model);

    expect(replay.outcome).toEqual({ status: "confirmed", result });
  });

  it("denies direct Worker inbound without allocating a Worker", async () => {
    let allocations = 0;
    const workerAttempts = {
      commands: {
        async create() {
          allocations += 1;
          throw new Error("must not allocate");
        },
        async requestStart() {
          return undefined;
        },
        async finish() {
          return undefined;
        },
        async requestDelivery() {
          throw new Error("must not deliver");
        },
        async settleDelivery() {
          return undefined;
        },
        async requestCancel() {
          return undefined;
        },
        async settleCancel() {
          return undefined;
        },
      },
      queries: {
        async byExecution() {
          return undefined;
        },
        async active() {
          return [];
        },
      },
    };
    const context: IngressHandlers.HandlerContext = {
      sessionId: "durable-worker-session",
      event: {
        id: "direct-worker-delivery",
        surface: "discord",
        payload: "hello",
        mode: "direct",
        target: { kind: "worker", sessionId: "durable-worker-session" },
        agent: { model: { provider: "test", id: "fixture" } },
      },
      coordinator: {
        async dispatch() {
          throw new Error("must not spawn");
        },
      },
      workerAttempts,
    };

    await expect(IngressHandlers.handleDirect(context)).rejects.toThrow(
      "no authoritative active Attempt",
    );
    expect(allocations).toBe(0);
  });
});
