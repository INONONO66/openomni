import { Journal } from "@openomni/agent";
const openCatalogStore = Journal.openCatalogStore;
const openSessionStore = Journal.openSessionStore;
type LedgerError = Journal.LedgerError;
import { Effect } from "effect";
import type { Inbox, LedgerAction, Storage as ProtocolStorage } from "@openomni/protocol";
import { createChannelStores, type ChannelStores } from "../../src/router/stores";
import { runEffect } from "./effect";

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
  readonly kernel: Journal.SessionHandleStore.SessionKernel;
  readonly stores: ChannelStores;
  /** Swaps only the decision-fact seam, live, for routers already built over this plane. */
  readonly setDecisionFacts: (facts: ProtocolStorage.DecisionFactSubAdapter | undefined) => void;
}

export interface TestLedgerPaths {
  readonly catalog: string;
  readonly sessions: string;
}

function createTestLedger(paths?: TestLedgerPaths): TestLedger {
  const catalog = openCatalogStore(paths?.catalog ?? ":memory:", { now: () => 1 });
  const sessions = openSessionStore(paths?.sessions ?? ":memory:", { now: () => 1 });
  const kernel = Journal.SessionHandleStore.createSessionKernel(sessions, catalog);
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
    now: () => 1,
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

/** Strictly-newer fence adoption on the shared fixture kernel (W5.2 F5). */
export function adoptLedgerFence(sessionId: string, owner: string): number {
  const kernel = current.plane.kernel;
  for (;;) {
    const row = kernel.row(sessionId);
    if (row.fenceOwner === owner) return row.fence;
    const adopted = runEffect(
      kernel.adoptFence({ sessionId, owner, fence: row.fence + 1 }).pipe(
        Effect.map((receipt) => receipt.fence),
        Effect.catchTag("FenceRefused", () => Effect.succeed(undefined)),
      ),
      "sync",
    );
    if (adopted !== undefined) return adopted;
  }
}

/**
 * The historical inbox commit, replayed onto the chain (W5.2 F1): one
 * `prompt` action whose intent is the origin and whose effect carries the
 * inbox kind + content; idempotent on the action id.
 */
export function commitReceivedMessage(
  input: Inbox.Commit,
): Effect.Effect<{ row: Inbox.Row }, LedgerError> {
  return Effect.suspend(() => {
    const kernel = current.plane.kernel;
    const asRow = (ordinal: number): Inbox.Row => ({
      id: input.id,
      sessionId: input.sessionId,
      kind: input.kind,
      content: input.content,
      origin: input.origin,
      status: "pending",
      consumedBy: null,
      consumedAt: null,
      createdAt: input.createdAt,
      ordinal,
    });
    const existing = kernel.actionById(input.id);
    if (existing !== undefined) return Effect.succeed({ row: asRow(existing.ordinal) });
    const fence = adoptLedgerFence(input.sessionId, "fixture-inbox");
    const row = kernel.row(input.sessionId);
    const action: LedgerAction.Append = {
      id: input.id,
      parentId: input.parentActionId,
      sessionId: input.sessionId,
      kind: "prompt",
      intent: input.origin,
      effect: { encodingVersion: 1, value: { inboxKind: input.kind, content: input.content } },
      irreversible: true,
      ts: input.createdAt,
    };
    return kernel
      .commit({
        sessionId: input.sessionId,
        owner: "fixture-inbox",
        fence,
        now: input.createdAt,
        expectedRevision: row.revision,
        actions: [action],
        state: row.state,
      })
      .pipe(
        Effect.map((committed) => ({
          row: asRow(committed.receipts[0]?.action.ordinal ?? row.revision + 1),
        })),
      );
  });
}
