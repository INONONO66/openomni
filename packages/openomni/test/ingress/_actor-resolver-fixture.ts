import { afterAll, beforeAll, beforeEach, mock } from "bun:test";
import type { PolicyContext, PolicyRegistration } from "@openomni/agent";
import {
  Ingress as IngressNamespace,
  PolicyDecision as ProtocolPolicyDecision,
  type Ingress,
} from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/session";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;

export function setupIngressActorResolverTest(): void {
  beforeAll(async () => {
    ({ IngressEngine } = await import("../../src/ingress/engine"));
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
    IngressEngine.reset();
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
    IngressEngine.setResidentRuntime(
      ResidentRuntime.create({
        runAgent: async (_config, input) => {
          testState.llmInputs.push(input);
          return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
        },
      }),
    );
  });
}

export function getIngressEngine(): typeof import("../../src/ingress/engine").IngressEngine {
  return IngressEngine;
}

export function makeEvent(
  userId: string,
  actor: Ingress.Actor = { role: "user", id: userId },
): Ingress.InboundEvent {
  return {
    id: `event-${userId}`,
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

export function captureActorPolicy(
  onActor: (actor: Ingress.Actor | undefined) => void,
): PolicyRegistration {
  return {
    name: "test:capture-actor",
    timing: "inbound.receive",
    priority: 0,
    fn: (ctx: PolicyContext) => {
      const actor = ctx.toolInput?.actor;
      onActor(actor === undefined ? undefined : IngressNamespace.ActorSchema.parse(actor));
      return ProtocolPolicyDecision.allow({
        policyId: "test.capture-actor",
        reasonCodes: ["captured"],
      });
    },
  };
}

export function registerOwnerEndpoint(workspace?: string): void {
  ActorRegistry.registerIdentity({
    id: "act_owner",
    kind: "human",
    trustTier: "owner",
    relationship: "owner",
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
