import { afterAll, beforeAll, beforeEach, mock } from "bun:test";
import {
  Ingress as IngressNamespace,
  PolicyDecision as ProtocolPolicyDecision,
  type Ingress,
} from "@openomni/protocol";
import { ActorRegistry, Bus, ChannelGrantStore, Storage } from "@openomni/session";
import type { IngressPolicyGate } from "../../src/ingress/policy-gate";
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
 * resident runtime; inbound policies are construction-injected (#549).
 */
export function getIngressEngine(...policies: IngressPolicyGate.IngressPolicy[]): IngressEngine {
  return createIngressEngine({
    residentRuntime: ResidentRuntime.create({
      runAgent: async (_config, input) => {
        testState.llmInputs.push(input);
        return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
      },
    }),
    policies,
  });
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
): IngressPolicyGate.IngressPolicy {
  return {
    name: "test:capture-actor",
    gate: "inbound",
    priority: 0,
    fn: (ctx) => {
      const actor = ctx.gate === "inbound" ? ctx.actor : undefined;
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
