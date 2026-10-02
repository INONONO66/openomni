import { Effect } from "effect";
import { commitFoldBatch } from "./session-fold-commit";
import * as SessionHandleStore from "./store/fence";
import type { LedgerError } from "./store/errors";
import type { SessionGeneration, LedgerSession } from "@openomni/protocol";
import type { SessionKernel } from "./cluster/kernel-registry";
import { CommitFailed, AgentFailure, type SessionError } from "./errors";
import type { ResolvedSessionRuntime, SessionSystem } from "./session-contract";
import type { SessionControllerState } from "./session-controller-state";

/**
 * Adopts a strictly newer fence for this writer (W5.2 F5). There is no lease
 * TTL and no heartbeat: the fence CAS is the whole takeover authority. A lost
 * single-increment race re-reads the row and re-decides from the fresh fence.
 */
export function adoptSessionAuthority(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): Effect.Effect<number, LedgerError> {
  const attempt: Effect.Effect<number, LedgerError> = Effect.suspend(() => {
    const current = kernel.row(sessionId);
    if (current.leaseOwner === owner) return Effect.succeed(current.leaseFence);
    return kernel
      .adoptFence({ sessionId, owner, fence: current.leaseFence + 1 })
      .pipe(
        Effect.map((receipt) => receipt.fence),
        Effect.catchTag("LeaseRefused", () => attempt),
      );
  });
  return attempt;
}

export function createSessionConfiguration(
  kernel: SessionKernel,
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
      const before = kernel.latestGenerationFor(sessionId);
      const generation = before.generation + 1;
      const accepted = yield* runtime.authorizeConfigure({
        sessionId, role: kernel.row(sessionId).role, operation, generation,
      });
      if (!accepted) return yield* new AgentFailure({ operation: "session.configure", cause: "denied" });
      const current = kernel.row(sessionId);
      const previous = kernel.latestGenerationFor(sessionId);
      if (previous.generation !== before.generation)
        return yield* new AgentFailure({ operation: "session.configure", cause: "stale" });
      const snapshot = SessionHandleStore.generationSnapshot({
        generation, revertTo: previous.generation, tools: nextTools,
        system: nextSystem, policyGeneration: previous.policyGeneration,
        bundles: previous.bundles,
      });
      const configured = SessionHandleStore.configureAction({
        id: entropy(), sessionId, parentId: kernel.latestAction(sessionId)?.id ?? null,
        operation, snapshot, at: clock(),
      });
      const commit = commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [configured], state: current.state,
        generation: { toolsGeneration: snapshot.generation, systemHash: snapshot.systemHash, policyGeneration: snapshot.policyGeneration },
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const committed = yield* runtime.generations.configure({ sessionId, generation }, snapshot, commit);
      yield* ports.hibernate(committed.row);
      return { generation: snapshot.generation, revertTo: snapshot.revertTo };
    });
  }

  return { configure };
}
