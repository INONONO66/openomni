import {
  createSessionKernel,
  openCatalogStore,
  openSessionStore,
  type SessionKernel,
} from "@openomni/ledger";
import { createChannelStores, type ChannelStores } from "../../src/router/stores";

/**
 * The channels test ledger plane (W5.2 F1): one in-memory catalog plus one
 * shared in-memory session store standing in for the per-session files. A
 * single kernel handle over that shared store reproduces the historical
 * module-level surface the suite was written against — every session's rows
 * and chains are reachable from `ledger().kernel`.
 */
export interface TestLedger {
  readonly catalog: ReturnType<typeof openCatalogStore>;
  readonly sessions: ReturnType<typeof openSessionStore>;
  readonly kernel: SessionKernel;
  readonly stores: ChannelStores;
}

export function createTestLedger(): TestLedger {
  const catalog = openCatalogStore(":memory:");
  const sessions = openSessionStore(":memory:");
  const kernel = createSessionKernel(sessions, catalog);
  const stores = createChannelStores({
    actorRegistry: catalog.actorRegistry,
    blacklist: catalog.blacklist,
    channelGrant: catalog.channelGrant,
    replyGrant: catalog.replyGrant,
    egressBudget: catalog.egressBudget,
    surfaceKey: catalog.surfaceKey,
    decisionFacts: sessions.decisionFacts,
    transaction: (operation) => sessions.transaction(operation),
  });
  return { catalog, sessions, kernel, stores };
}

const current: { plane: TestLedger } = { plane: createTestLedger() };

/** The suite's shared plane; `resetLedger()` swaps in a fresh one. */
export function ledger(): TestLedger {
  return current.plane;
}

export function resetLedger(): TestLedger {
  current.plane.sessions.close();
  current.plane.catalog.close();
  current.plane = createTestLedger();
  return current.plane;
}

/** Preserve the real transaction while replacing only the decision-fact seam. */
export function replaceDecisionFacts(
  replace: (
    facts: NonNullable<TestLedger["sessions"]["decisionFacts"]>,
  ) => TestLedger["sessions"]["decisionFacts"] | undefined,
): ChannelStores {
  const plane = current.plane;
  const stores = createChannelStores({
    actorRegistry: plane.catalog.actorRegistry,
    blacklist: plane.catalog.blacklist,
    channelGrant: plane.catalog.channelGrant,
    replyGrant: plane.catalog.replyGrant,
    egressBudget: plane.catalog.egressBudget,
    surfaceKey: plane.catalog.surfaceKey,
    ...(replace(plane.sessions.decisionFacts) === undefined
      ? {}
      : { decisionFacts: replace(plane.sessions.decisionFacts) }),
    transaction: (operation) => plane.sessions.transaction(operation),
  });
  return stores;
}
