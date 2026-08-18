import { Ingress as IngressNamespace, Operational, type Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Session, Storage, SurfaceKey } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";
import {
  createIngressEngine,
  type IngressEngine,
  type IngressEngineDeps,
} from "../../src/ingress/engine";
import { IngressSessionResolver } from "../../src/ingress/session-resolver";
import { ResidentRuntime } from "../../src/resident/runtime";

export const ownerEvent = {
  id: "inbound-owner-dm",
  traceId: "trace-test",
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
    traceId: "trace-test",
    title: "Owner DM",
    model: { providerID: "test", modelID: "test-model" },
  });
  SurfaceKey.claim(IngressSessionResolver.extractSurfaceKey(ownerEvent), session.id);
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

const RoutedFactsSchema = z.object({
  audit: z.object({
    payload: z.object({
      eventId: z.string(),
      actor: z.unknown().optional(),
      inboundTreatment: z.unknown().optional(),
    }),
  }),
});

/**
 * Observes the routed actor and inbound treatment as projected by the ingress
 * event projector: the `ingress.inbound.project` audit fact carries both
 * `meta.actor` (after channel default-tier materialization and canonical
 * identity resolution) and `inboundTreatment`. This replaces the retired
 * inbound-gate capture probe — routed pre-run authority is the only ingress
 * policy point now, so routed facts are asserted at the projection seam they
 * land on. The project fact is the sole inbound audit payload carrying an
 * actor, so gating on actor presence selects it. Bus delivery is a microtask,
 * so callers must `await flushBusObservers()` before asserting.
 */
export function observeRoutedFacts(
  eventId: string,
  captured: { actor?: unknown; treatment?: unknown },
): () => void {
  return Bus.observe((event, data) => {
    if (event.name !== Operational.Events.Info.name) return;
    const parsed = Operational.Events.Info.schema.safeParse(data);
    if (!parsed.success) return;
    const audit = RoutedFactsSchema.safeParse(parsed.data.context);
    if (!audit.success) return;
    const payload = audit.data.audit.payload;
    if (payload.eventId !== eventId) return;
    if (payload.actor === undefined) return;
    captured.actor = IngressNamespace.ActorSchema.parse(payload.actor);
    captured.treatment = payload.inboundTreatment;
  });
}

export async function flushBusObservers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
