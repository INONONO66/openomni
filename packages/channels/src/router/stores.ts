import {
  createActorRegistry,
  createBlacklistStore,
  createChannelGrantStore,
  createDecisionFactPort,
  createEgressBudgetStore,
  createReplyGrantStore,
  createSurfaceKeyStore,
} from "@openomni/ledger";
import type { Storage as ProtocolStorage } from "@openomni/protocol";

/**
 * The perimeter's store plane over one composition-bound catalog handle
 * (W5.2 F1): the router consumes handle-scoped store factories instead of the
 * deleted process-global ledger singletons. The composition root builds one
 * plane and threads it through `createGatewayRouter`; a source without an
 * adapter keeps each factory's fail-closed refusal and `decisionFacts.port()`
 * resolves to `undefined` — exactly the historical "storage not configured"
 * posture.
 */
export interface ChannelStoreSource {
  readonly actorRegistry?: ProtocolStorage.ActorRegistrySubAdapter;
  readonly blacklist?: ProtocolStorage.BlacklistSubAdapter;
  readonly channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
  readonly replyGrant?: ProtocolStorage.ReplyGrantSubAdapter;
  readonly egressBudget?: ProtocolStorage.EgressBudgetSubAdapter;
  readonly surfaceKey?: ProtocolStorage.SurfaceKeySubAdapter;
  readonly decisionFacts?: ProtocolStorage.DecisionFactSubAdapter;
  /** Injected wall clock (#1245): the store plane never reads ambient time. */
  readonly now: () => number;
  transaction<T>(operation: () => T): T;
}

/** Builds the router's store plane over one source handle; no ambient state. */
export function createChannelStores(source: ChannelStoreSource) {
  return {
    actors: createActorRegistry(source),
    blacklist: createBlacklistStore(source),
    channelGrants: createChannelGrantStore(source),
    replyGrants: createReplyGrantStore(source),
    egressBudgets: createEgressBudgetStore(source),
    surfaceKeys: createSurfaceKeyStore(source),
    decisionFacts: createDecisionFactPort(source),
    transaction: <T>(operation: () => T): T => source.transaction(operation),
  };
}

export type ChannelStores = ReturnType<typeof createChannelStores>;

/** The unconfigured plane: every store keeps its own fail-closed refusal. */
export function unconfiguredChannelStores(now: () => number): ChannelStores {
  return createChannelStores({ now, transaction: (operation) => operation() });
}
