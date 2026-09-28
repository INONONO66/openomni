import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import type { Storage as ProtocolStorage } from "@openomni/protocol";
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
  readonly kernel: SessionHandleStore.SessionKernel;
  readonly stores: ChannelStores;
  /** Swaps only the decision-fact seam, live, for routers already built over this plane. */
  readonly setDecisionFacts: (
    facts: ProtocolStorage.DecisionFactSubAdapter | undefined,
  ) => void;
}

export interface TestLedgerPaths {
  readonly catalog: string;
  readonly sessions: string;
}

export function createTestLedger(paths?: TestLedgerPaths): TestLedger {
  const catalog = openCatalogStore(paths?.catalog ?? ":memory:");
  const sessions = openSessionStore(paths?.sessions ?? ":memory:");
  const kernel = SessionHandleStore.createSessionKernel(sessions, catalog);
  const seam: { facts: ProtocolStorage.DecisionFactSubAdapter | undefined } = {
    facts: sessions.decisionFacts,
  };
  const stores = createChannelStores({
    actorRegistry: catalog.actorRegistry,
    blacklist: catalog.blacklist,
    channelGrant: catalog.channelGrant,
    replyGrant: catalog.replyGrant,
    egressBudget: catalog.egressBudget,
    surfaceKey: catalog.surfaceKey,
    get decisionFacts() {
      return seam.facts;
    },
    transaction: (operation) => sessions.transaction(operation),
  });
  return {
    catalog,
    sessions,
    kernel,
    stores,
    setDecisionFacts: (facts) => {
      seam.facts = facts;
    },
  };
}

const current: { plane: TestLedger } = { plane: createTestLedger() };

/** The suite's shared plane; `resetLedger()` swaps in a fresh one. */
export function ledger(): TestLedger {
  return current.plane;
}

export function resetLedger(paths?: TestLedgerPaths): TestLedger {
  current.plane.sessions.close();
  current.plane.catalog.close();
  current.plane = createTestLedger(paths);
  return current.plane;
}

/** Preserve the real transaction while replacing only the decision-fact seam. */
export function replaceDecisionFacts(
  replace: (
    facts: ProtocolStorage.DecisionFactSubAdapter,
  ) => ProtocolStorage.DecisionFactSubAdapter | undefined,
): void {
  const facts = current.plane.sessions.decisionFacts;
  current.plane.setDecisionFacts(replace(facts));
}
