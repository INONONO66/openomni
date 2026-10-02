import type { LedgerError } from "../../src/store";
import type { Inbox, LedgerAction, LedgerSession } from "@openomni/protocol";
import { Effect } from "effect";
import type { SessionKernel } from "../../src/cluster/kernel-registry";
import { receivedMessageAction } from "../../src/session-record";

export interface ReceivedMessageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Inbox.Kind;
  readonly content: string;
  readonly origin: Inbox.Origin;
  readonly createdAt: number;
  readonly parentActionId: string | null;
}

/**
 * Out-of-band ingress as one fenced received-message chain commit (the inbox
 * table is gone; the chain is the inbox). A session with a live writer keeps
 * that writer's authority — ingress rides the current owner+fence exactly like
 * the entity's requestCommand; an unowned session adopts the ingress fence.
 */
export function commitReceivedMessage(
  kernel: SessionKernel,
  input: ReceivedMessageInput,
): Effect.Effect<{ row: LedgerSession.Row; receipt: LedgerAction.Receipt }, LedgerError> {
  return Effect.suspend(() => {
    const current = kernel.row(input.sessionId);
    const writer =
      current.leaseOwner === null
        ? kernel
            .adoptFence({ sessionId: input.sessionId, owner: "ingress", fence: current.leaseFence + 1 })
            .pipe(Effect.map((adopted) => ({ owner: "ingress", fence: adopted.fence })))
        : Effect.succeed({ owner: current.leaseOwner, fence: current.leaseFence });
    return writer.pipe(
      Effect.flatMap(({ owner, fence }) =>
        kernel.commit({
          sessionId: input.sessionId,
          owner,
          fence,
          now: input.createdAt,
          expectedRevision: current.revision,
          actions: [
            receivedMessageAction({
              id: input.id,
              sessionId: input.sessionId,
              kind: input.kind,
              content: input.content,
              origin: input.origin,
              parentActionId: input.parentActionId,
              at: input.createdAt,
            }),
          ],
          state: current.state,
        }),
      ),
      Effect.map((committed) => {
        const receipt = committed.receipts[0];
        if (receipt === undefined) throw new Error("received-message receipt missing");
        return { row: committed.row, receipt };
      }),
    );
  });
}
