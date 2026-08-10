import type { Ingress } from "@openomni/protocol";
import {
  ActorRegistry,
  Bus,
  ChannelGrantStore,
  Session,
  Storage,
  SurfaceKey,
} from "@openomni/session";
import {
  createIngressEngine,
  type IngressEngine,
  type IngressEngineDeps,
} from "../../src/ingress/engine";
import { IngressSessionResolver } from "../../src/ingress/session-resolver";
import { ResidentRuntime } from "../../src/resident/runtime";

export const ownerEvent = {
  id: "inbound-owner-dm",
  surface: "discord",
  workspace: "owner-workspace",
  channel: "owner-dm",
  userId: "owner-external-id",
  mode: "direct",
  payload: "hello resident",
  meta: { actor: { role: "user" } },
  agent: { model: { provider: "test", id: "test-model" } },
} satisfies Ingress.DirectEvent;

export const residentExecutions: string[] = [];

let engine: IngressEngine | undefined;

export function resetKernelRoutingState(): void {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
  residentExecutions.length = 0;
  engine = makeKernelRoutingEngine();
}

/** The engine created for the current test by resetKernelRoutingState(). */
export function kernelEngine(): IngressEngine {
  if (!engine) throw new Error("resetKernelRoutingState() must run before kernelEngine()");
  return engine;
}

/**
 * Rebuilds the current test's engine with extra construction deps (#549) —
 * e.g. a dispatch runtime — keeping the shared recording resident runtime.
 */
export function makeKernelRoutingEngine(deps: IngressEngineDeps = {}): IngressEngine {
  engine = createIngressEngine({
    residentRuntime: ResidentRuntime.create({
      runAgent: async () => {
        residentExecutions.push("executed");
        return { text: "resident response", finishReason: "stop" };
      },
    }),
    ...deps,
  });
  return engine;
}

export function registerOwnerDm(): void {
  ActorRegistry.registerIdentity({
    id: "actor-owner",
    kind: "human",
    trustTier: "owner",
    relationship: "owner",
  });
  ActorRegistry.registerEndpoint({
    id: "endpoint-owner-dm",
    actorId: "actor-owner",
    channel: ownerEvent.surface,
    externalId: ownerEvent.userId,
    workspace: ownerEvent.workspace,
  });
  ChannelGrantStore.put({
    id: "grant-owner-dm",
    surface: ownerEvent.surface,
    workspace: ownerEvent.workspace,
    channel: ownerEvent.channel,
    kind: "trusted_channel",
    createdBy: "actor-owner",
  });
}

export function createMappedOwnerSession(): Session.Info {
  const session = Session.create({
    title: "Owner DM",
    model: { providerID: "test", modelID: "test-model" },
  });
  SurfaceKey.register(IngressSessionResolver.extractSurfaceKey(ownerEvent), session.id);
  return session;
}

export function routingDecisions(): {
  readonly decisions: unknown[];
  readonly unsubscribe: () => void;
} {
  const decisions: unknown[] = [];
  const unsubscribe = Bus.observe((event, payload) => {
    if (event.name === "ingress.routing.decision") decisions.push(payload);
  });
  return { decisions, unsubscribe };
}
