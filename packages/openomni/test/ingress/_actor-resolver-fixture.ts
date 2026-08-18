import { afterAll, beforeAll, beforeEach, mock } from "bun:test";
import { Ingress as IngressNamespace, Operational, type Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

type IngressEngine = import("../../src/ingress/engine").IngressEngine;

let createIngressEngine: typeof import("../../src/ingress/engine")["createIngressEngine"];
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;

export function setupIngressActorResolverTest(): void {
  beforeAll(async () => {
    ({ createIngressEngine } = await import("../../src/ingress/engine"));
    ({ ResidentRuntime } = await import("../../src/resident/runtime"));
  });

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    resetTestState();
    testState.runFn = defaultRunFn("actor-resolver-test");
    mockModelsGet.mockClear();
    mockProviderFromModelsDevModel.mockClear();
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    ChannelGrantStore.put({
      id: "grant-discord-guild-dev",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
    ChannelGrantStore.put({
      id: "grant-discord-guild-b-dev",
      surface: "discord",
      workspace: "guild-b",
      channel: "dev",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
    ChannelGrantStore.put({
      id: "grant-telegram-guild-dev",
      surface: "telegram",
      workspace: "guild",
      channel: "dev",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
  });
}

/**
 * Builds a fresh engine instance for the current test with the shared mock
 * resident runtime.
 */
export function getIngressEngine(): IngressEngine {
  return createIngressEngine({
    residentRuntime: ResidentRuntime.create({
      runAgent: async (_config, input) => {
        testState.llmInputs.push(input);
        return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
      },
    }),
  });
}

export function makeEvent(
  userId: string,
  actor: Ingress.Actor = { role: "user", id: userId },
): Ingress.InboundEvent {
  return {
    id: `event-${userId}`,
    traceId: "trace-test",
    surface: "discord",
    workspace: "guild",
    channel: "dev",
    userId,
    mode: "direct",
    payload: "hello",
    meta: { actor },
    agent: { model: { provider: "anthropic", id: "claude-3-haiku-20240307" } },
  };
}

const AuditActorSchema = z.object({
  audit: z.object({
    payload: z.object({
      eventId: z.string(),
      actor: z.unknown().optional(),
    }),
  }),
});

/**
 * Observes the resolved actor as projected by the ingress event projector:
 * the `ingress.inbound.project` audit fact carries `meta.actor` after routing
 * treatment (channel default tier, canonical identity). This replaces the
 * retired inbound-gate capture probe — routed pre-run authority is the only
 * ingress policy point now, so actor resolution is asserted at the projection
 * seam the resolved actor lands on. Fires only for the project fact (the sole
 * inbound audit payload that carries an actor). Bus delivery is a microtask,
 * so callers must `await flushBusObservers()` before asserting.
 */
export function observeResolvedActor(
  eventId: string,
  onActor: (actor: Ingress.Actor) => void,
): () => void {
  return Bus.observe((event, data) => {
    if (event.name !== Operational.Events.Info.name) return;
    const parsed = Operational.Events.Info.schema.safeParse(data);
    if (!parsed.success) return;
    const audit = AuditActorSchema.safeParse(parsed.data.context);
    if (!audit.success) return;
    if (audit.data.audit.payload.eventId !== eventId) return;
    if (audit.data.audit.payload.actor === undefined) return;
    onActor(IngressNamespace.ActorSchema.parse(audit.data.audit.payload.actor));
  });
}

export function registerOwnerEndpoint(workspace?: string): void {
  ActorRegistry.registerIdentity({
    id: "act_owner",
    kind: "human",
    trustTier: "owner",
  });
  ActorRegistry.registerEndpoint({
    id: "ep_discord_user_1",
    actorId: "act_owner",
    channel: "discord",
    externalId: "user-1",
    workspace,
  });
}

export async function flushBusObservers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export { testState };
