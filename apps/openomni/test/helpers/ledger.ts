import {
  Clock,
  createSessionEntityRunTurn,
  decideSessionAdmission,
  Entropy,
  ForeignFailure,
  GenerationLayers,
  ObservationSink,
  type SessionEntryServices,
  type SessionError,
  type SessionRuntime,
} from "@openomni/agent";
import type { LedgerError } from "@openomni/ledger";
import type { Inbox, LedgerAction, SessionTurn } from "@openomni/protocol";
import { Context, Effect, type Scope } from "effect";
import {
  AppLedger,
  createAppLedger,
  type AppLedgerPlane,
  type SessionKernel,
} from "../../src/composition/cluster-runtime";
import { materializeInboxTarget } from "../../src/composition/message-session";
import type { AppRuntime } from "../../src/runtime";
import { runRuntimeEffect } from "./effect";

/** A standalone app ledger plane for fixtures that never boot the runtime. */
export function testPlane(
  options: Parameters<typeof createAppLedger>[0] = {},
): AppLedgerPlane {
  return createAppLedger(options);
}

/** The booted runtime's own plane — the one the entity and boot share. */
export function planeOf(runtime: AppRuntime): Promise<AppLedgerPlane> {
  return runRuntimeEffect(runtime, Effect.map(AppLedger, (plane) => plane));
}

/** Strictly-newer fence adoption on a fixture kernel (the entity's own CAS). */
export function adoptTestFence(
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

/**
 * A cluster-free inbox commit for fixtures: the historical delivery as one
 * `prompt` chain action under an adopted fence, idempotent on the action id.
 * Mirrors the process child's local delivery (src/process-entry.ts).
 */
export function localInbox(
  plane: AppLedgerPlane,
  owner = "test-inbox",
  clock: () => number = () => Date.now(),
) {
  return (input: Inbox.Commit): Effect.Effect<Inbox.Row, ForeignFailure> =>
    Effect.gen(function* () {
      yield* materializeInboxTarget(plane, input, clock);
      const kernel = plane.openKernel(input.sessionId);
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
      if (existing !== undefined) return asRow(existing.ordinal);
      const refuse = (error: { readonly _tag: string }) =>
        new ForeignFailure({ operation: "message.commit", cause: error._tag });
      const fence = yield* adoptTestFence(kernel, input.sessionId, owner).pipe(
        Effect.mapError(refuse),
      );
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
      const committed = yield* kernel
        .commit({
          sessionId: input.sessionId,
          owner,
          fence,
          now: clock(),
          expectedRevision: row.revision,
          actions: [action],
          state: row.state,
        })
        .pipe(Effect.mapError(refuse));
      const receipt = committed.receipts[0];
      if (receipt === undefined)
        return yield* new ForeignFailure({ operation: "message.commit", cause: "no receipt" });
      return asRow(receipt.action.ordinal);
    });
}

export type ResolvedTestRuntime = Parameters<typeof createSessionEntityRunTurn>[1];

/** The app's runtime resolution, replayed for fixtures over a built service context. */
export function resolvedRuntimeFor(
  runtime: SessionRuntime,
  context: Context.Context<SessionEntryServices>,
): ResolvedTestRuntime {
  return {
    ...runtime,
    clock: Context.get(context, Clock).now,
    entropy: Context.get(context, Entropy).next,
    observations: Context.get(context, ObservationSink),
    generations: Context.get(context, GenerationLayers),
    services: context,
  };
}

/**
 * The entity's backlog drain, minus the mailbox (mirrors the process child):
 * adopt the fence once, then run admitted decisions until the chain says
 * stop. Returns the latest turn terminal the drain settled.
 */
export function drainSession(deps: {
  readonly plane: AppLedgerPlane;
  readonly sessionId: string;
  readonly runner: Parameters<typeof createSessionEntityRunTurn>[0];
  readonly runtime: ResolvedTestRuntime;
  readonly scope: Scope.Scope;
  readonly owner?: string;
}): Effect.Effect<SessionTurn.Terminal | undefined, SessionError | LedgerError> {
  const owner = deps.owner ?? "test-drain";
  const kernel = deps.plane.openKernel(deps.sessionId);
  const runTurn = createSessionEntityRunTurn(deps.runner, deps.runtime, deps.scope);
  return Effect.gen(function* () {
    const fence = yield* adoptTestFence(kernel, deps.sessionId, owner);
    const authority = { sessionId: deps.sessionId, owner, fence };
    for (;;) {
      const row = kernel.row(deps.sessionId);
      const open = kernel.latestOpenTurn(deps.sessionId);
      const terminal = kernel.latestTurnTerminal(deps.sessionId);
      const snapshot = {
        row,
        pending: kernel.pendingMessages(deps.sessionId),
        ...(open === undefined ? {} : { open }),
        ...(terminal === undefined ? {} : { terminal }),
      };
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
          return kernel.latestTurnTerminal(deps.sessionId)?.effect;
        case "refused":
          return yield* new ForeignFailure({ operation: "session.admission", cause: "invalid_state" });
        case "consume":
          // The consume fold is entity-owned; a fixture reaching it is a
          // wiring defect, not backlog to silently drop.
          return yield* new ForeignFailure({ operation: "session.admission", cause: "consume_in_fixture" });
        case "start":
          // Inline detach: this drain owns the whole turn's lifetime itself.
          yield* runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach: (body) => body });
          continue;
        default:
          yield* runTurn({ authority, kernel, decision, snapshot, detach: (body) => body });
          continue;
      }
    }
  });
}
