import { ForeignFailure } from "@openomni/agent";
import type { LedgerError } from "@openomni/ledger";
import type { Inbox, LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import {
  AppLedger,
  createAppLedger,
  type AppLedgerPlane,
  type SessionKernel,
} from "../../src/composition/cluster-runtime";
import { materializeInboxTarget } from "../../src/composition/message-session";
import type { AppRuntime } from "../../src/runtime";

/** A standalone app ledger plane for fixtures that never boot the runtime. */
export function testPlane(
  options: Parameters<typeof createAppLedger>[0] = {},
): AppLedgerPlane {
  return createAppLedger(options);
}

/** The booted runtime's own plane — the one the entity and boot share. */
export function planeOf(runtime: AppRuntime): Promise<AppLedgerPlane> {
  return runtime.runPromise(Effect.map(AppLedger, (plane) => plane));
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
