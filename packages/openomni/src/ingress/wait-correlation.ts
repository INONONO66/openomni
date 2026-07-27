import type { Wait } from "@openomni/protocol";

export type WaitRouteV1 = Readonly<
  | {
      kind: "resident";
      sessionId: string;
      runId?: string;
    }
  | {
      kind: "worker";
      sessionId: string;
      runId: string;
    }
>;

/** Kernel projection for one durable Wait. This is deliberately not a legacy store record. */
export type DurableWaitV1 = Readonly<{
  waitId: string;
  revision: string;
  opened: Wait.OpenedV1;
  status: Wait.StatusV1;
  route: WaitRouteV1;
  resolvedAtDbMs?: number;
  routingDeadlineDbMs?: number;
  routedDispatchId?: string;
  routedAction?: Wait.AllowedActionV1;
}>;

export type WaitCorrelationCandidate = Readonly<{
  key: `wait:${string}`;
  wait: DurableWaitV1;
}>;

export type ResolveWaitCorrelationInput = Readonly<{
  endpointId?: string;
  channelId?: string;
  correlation?: Wait.CorrelationV1;
}>;

export type WaitCorrelationResolution =
  | Readonly<{ kind: "none"; candidates: readonly [] }>
  | Readonly<{ kind: "match"; candidate: WaitCorrelationCandidate }>
  | Readonly<{ kind: "ambiguous"; candidates: readonly WaitCorrelationCandidate[] }>;

export type WaitCorrelationEffect =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "stage_ambiguity";
      candidates: readonly WaitCorrelationCandidate[];
    }>;

export type OpenWaitInputV1 = Readonly<{
  waitId: string;
  ownerRef: Wait.OwnerRefV1;
  expectedResponders: readonly Wait.ResponderRefV1[];
  route: WaitRouteV1;
  correlation: Wait.CorrelationV1;
  allowedActions: readonly Wait.AllowedActionV1[];
  targetActorId?: string;
  endpointId?: string;
  channelId?: string;
}>;

export type WaitResponseInputV1 = Readonly<{
  waitId: string;
  transportId: string;
  responder: Wait.ResponderRefV1;
  action: Wait.AllowedActionV1;
  payload: unknown;
}>;

export type PinnedWaitRevalidationInputV1 = Readonly<{
  pinned: DurableWaitV1;
  requestedAction: Wait.AllowedActionV1;
  resolvedSinceDbMs?: number;
}>;

export type PinnedWaitRevalidationV1 =
  | Readonly<{ kind: "valid"; wait: DurableWaitV1 }>
  | Readonly<{ kind: "invalid"; reason: string }>;

/**
 * Native Wait authority. Implementations translate these operations to the closed WT/DP command
 * families and projection queries; callers cannot inspect storage or choose correlation precedence.
 */
export interface WaitKernelService {
  correlate(input: ResolveWaitCorrelationInput): Promise<WaitCorrelationResolution>;
  revalidatePinned(input: PinnedWaitRevalidationInputV1): Promise<PinnedWaitRevalidationV1>;
  acceptResponse(input: WaitResponseInputV1): Promise<DurableWaitV1>;
  settle(input: WaitResponseInputV1): Promise<DurableWaitV1>;
  cancel(input: { readonly waitId: string; readonly reason: string }): Promise<void>;
  stageAmbiguity(input: {
    readonly candidates: readonly WaitCorrelationCandidate[];
    readonly transportId: string;
  }): Promise<void>;
  markRouted(input: {
    readonly waitId: string;
    readonly dispatchId: string;
    readonly action: Wait.AllowedActionV1;
  }): Promise<void>;
}

export interface WaitKernelQueryService {
  correlate(input: ResolveWaitCorrelationInput): Promise<WaitCorrelationResolution>;
  revalidatePinned(input: PinnedWaitRevalidationInputV1): Promise<PinnedWaitRevalidationV1>;
}

export interface WaitKernelTransitionService {
  acceptResponse(input: WaitResponseInputV1): Promise<DurableWaitV1>;
  settle(input: WaitResponseInputV1): Promise<DurableWaitV1>;
  cancel(input: { readonly waitId: string; readonly reason: string }): Promise<void>;
  stageAmbiguity(input: {
    readonly candidates: readonly WaitCorrelationCandidate[];
    readonly transportId: string;
  }): Promise<void>;
  markRouted(input: {
    readonly waitId: string;
    readonly dispatchId: string;
    readonly action: Wait.AllowedActionV1;
  }): Promise<void>;
}

export function createWaitKernelService(
  queries: WaitKernelQueryService,
  transitions: WaitKernelTransitionService,
): WaitKernelService {
  const service: WaitKernelService = {
    correlate(input: ResolveWaitCorrelationInput) {
      return queries.correlate(input);
    },
    revalidatePinned(input: PinnedWaitRevalidationInputV1) {
      return queries.revalidatePinned(input);
    },
    acceptResponse(input: WaitResponseInputV1) {
      return transitions.acceptResponse(input);
    },
    settle(input: WaitResponseInputV1) {
      return transitions.settle(input);
    },
    cancel(input: { readonly waitId: string; readonly reason: string }) {
      return transitions.cancel(input);
    },
    stageAmbiguity(input) {
      return transitions.stageAmbiguity(input);
    },
    markRouted(input) {
      return transitions.markRouted(input);
    },
  };
  return Object.freeze(service);
}

export function resolveWaitCorrelation(
  service: WaitKernelService,
  input: ResolveWaitCorrelationInput,
): Promise<WaitCorrelationResolution> {
  return service.correlate(input);
}

export async function applyWaitCorrelationEffect(
  service: WaitKernelService,
  effect: WaitCorrelationEffect,
  transportId: string,
): Promise<void> {
  switch (effect.kind) {
    case "none":
      return;
    case "stage_ambiguity":
      await service.stageAmbiguity({ candidates: effect.candidates, transportId });
      return;
    default: {
      const unreachable: never = effect;
      throw new TypeError(`Unreachable wait correlation effect: ${String(unreachable)}`);
    }
  }
}
