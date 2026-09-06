import { SessionHandleStore } from "@openomni/ledger";
import { Deadline, SessionGeneration, type LedgerSession } from "@openomni/protocol";
import { SessionLeaseError, type SessionRuntime, type SessionSystem } from "./session-contract";
import { requireCommit } from "./session-record";
import type { SessionControllerState } from "./session-controller-state";

export function createSessionConfiguration(
  sessionId: string,
  runtime: SessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: { readonly hibernate: (current: LedgerSession.Row) => Promise<void> },
) {
  const { hibernate } = ports;
  async function configure(
    operation: SessionGeneration.ConfigureIntent["operation"],
    nextTools: readonly SessionGeneration.Tool[],
    nextSystem: SessionSystem,
  ): Promise<SessionGeneration.ConfigureReceipt> {
    const before = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
    const generation = before.generation + 1;
    const configureAccepted =
      (await runtime.authorizeConfigure?.({
        sessionId,
        role: SessionHandleStore.row(sessionId).role,
        operation,
        generation,
      })) ?? true;
    if (!configureAccepted) {
      throw new SessionGeneration.ConfigureError({
        code: "denied",
        message: `session configure denied: ${operation}`,
      });
    }
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    const previous = SessionHandleStore.latestGeneration(actions);
    if (previous.generation !== before.generation) {
      throw new SessionGeneration.ConfigureError({
        code: "stale",
        message: `session generation advanced during configure: ${sessionId}`,
      });
    }
    const snapshot = SessionHandleStore.generationSnapshot({
      generation,
      revertTo: previous.generation,
      tools: nextTools,
      system: nextSystem,
      policyGeneration: previous.policyGeneration,
    });
    // This executor holds the live lease while a turn is running AND while an
    // abort-ignoring runner is still alive after its interrupted terminal was
    // sealed. In both cases keep the existing fence and never release: the
    // runner's own settlement path owns the release (session-wide single flight).
    const ownsRunningLease =
      current.leaseOwner === owner &&
      (state.active !== undefined ||
        current.state === "running" ||
        state.liveInterruptRunner !== undefined);
    state.fence = ownsRunningLease ? current.leaseFence : acquire(current.leaseFence);
    const configured = SessionHandleStore.configureAction({
      id: entropy(),
      sessionId,
      parentId: actions.at(-1)?.id ?? null,
      operation,
      snapshot,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [configured],
      consumeInboxIds: [],
      state: current.state,
      generation: {
        toolsGeneration: snapshot.generation,
        systemHash: snapshot.systemHash,
        policyGeneration: snapshot.policyGeneration,
      },
      releaseLease: !ownsRunningLease,
    });
    const configuredRow = requireCommit(committed);
    await hibernate(configuredRow);
    return { generation: snapshot.generation, revertTo: snapshot.revertTo };
  }

  function acquire(expectedFence: number): number {
    const now = clock();
    const result = SessionHandleStore.acquireLease({
      sessionId,
      owner,
      expectedFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    if (!result.ok) throw new SessionLeaseError(result);
    return result.fence;
  }

  // Same liveness rule the ledger's fenced commit applies: a lapsed lease is
  // dead (TTL takeover territory) even while the row still names its owner.
  function leaseLive(row: LedgerSession.Row): boolean {
    return (
      row.leaseOwner !== null &&
      row.leaseExpiresAt !== null &&
      !Deadline.isExpired(clock(), row.leaseExpiresAt)
    );
  }

  async function releaseHeldLease(): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    // Lease already stolen or lapsed: nothing of ours left to release. A lapsed
    // lease is recoverable by TTL takeover; releasing it would be refused as
    // stale by the fenced kernel.
    if (current.leaseOwner !== owner || current.leaseFence !== state.fence) return;
    if (!leaseLive(current)) return;
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [],
      consumeInboxIds: [],
      state: current.state,
      releaseLease: true,
    });
    requireCommit(committed);
  }
  return { configure, acquire, leaseLive, releaseHeldLease };
}
