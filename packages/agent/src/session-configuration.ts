import { Effect } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import { Deadline, type SessionGeneration, type LedgerSession } from "@openomni/protocol";
import { CommitFailed, ForeignFailure, type SessionError } from "./errors";
import type { ResolvedSessionRuntime, SessionSystem } from "./session-contract";
import type { SessionControllerState } from "./session-controller-state";

export function createSessionConfiguration(
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: {
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function configure(
    operation: SessionGeneration.ConfigureIntent["operation"],
    nextTools: readonly SessionGeneration.Tool[],
    nextSystem: SessionSystem,
  ): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError> {
    return Effect.gen(function* () {
      const before = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
      const generation = before.generation + 1;
      const accepted = yield* (runtime.authorizeConfigure?.({
        sessionId, role: SessionHandleStore.row(sessionId).role, operation, generation,
      }) ?? Effect.succeed(true));
      if (!accepted) return yield* new ForeignFailure({ operation: "session.configure", cause: "denied" });
      const current = SessionHandleStore.row(sessionId);
      const actions = SessionHandleStore.tree(sessionId);
      const previous = SessionHandleStore.latestGeneration(actions);
      if (previous.generation !== before.generation)
        return yield* new ForeignFailure({ operation: "session.configure", cause: "stale" });
      const snapshot = SessionHandleStore.generationSnapshot({
        generation, revertTo: previous.generation, tools: nextTools,
        system: nextSystem, policyGeneration: previous.policyGeneration,
        bundles: previous.bundles,
      });
      const ownsRunningLease = current.leaseOwner === owner &&
        (state.active !== undefined || current.state === "running" || state.rawSlots.pending() > 0);
      state.fence = ownsRunningLease ? current.leaseFence : yield* acquire(current.leaseFence);
      const configured = SessionHandleStore.configureAction({
        id: entropy(), sessionId, parentId: actions.at(-1)?.id ?? null,
        operation, snapshot, at: clock(),
      });
      const commit = SessionHandleStore.commit({
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [configured], consumeInboxIds: [], state: current.state,
        generation: { toolsGeneration: snapshot.generation, systemHash: snapshot.systemHash, policyGeneration: snapshot.policyGeneration },
        releaseLease: !ownsRunningLease,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const committed = yield* runtime.generations.configure({ sessionId, generation }, snapshot, commit);
      yield* ports.hibernate(committed.row);
      return { generation: snapshot.generation, revertTo: snapshot.revertTo };
    });
  }

  function acquire(expectedFence: number) {
    return Effect.suspend(() => {
      const now = clock();
      return SessionHandleStore.acquireLease({
        sessionId, owner, expectedFence, now, expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
      }).pipe(Effect.map((result) => result.fence));
    });
  }

  function leaseLive(row: LedgerSession.Row): boolean {
    return row.leaseOwner !== null && row.leaseExpiresAt !== null && !Deadline.isExpired(clock(), row.leaseExpiresAt);
  }

  function releaseHeldLease() {
    return Effect.suspend(() => {
      const current = SessionHandleStore.row(sessionId);
      if (current.leaseOwner !== owner || current.leaseFence !== state.fence || !leaseLive(current)) return Effect.void;
      return SessionHandleStore.commit({
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [], consumeInboxIds: [], state: current.state, releaseLease: true,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
    });
  }
  return { configure, acquire, leaseLive, releaseHeldLease };
}
