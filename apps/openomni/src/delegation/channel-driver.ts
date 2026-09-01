import type { ExistingAgentMessaging } from "@openomni/channels";
import type { ConversationStore } from "@openomni/ledger";
import type { Delegation, Gateway } from "@openomni/protocol";
import type { Admitted } from "./admission";
import { renderInstruction } from "./instruction";
import { delegationTraceId } from "./trace";
import type {
  DelegationDriver,
  DriverOutcome,
  DriverPreparation,
  DriverReport,
} from "./kernel";

export interface ChannelDriverPorts {
  /** The gateway's #215 send kernel; every contact grant stays behind it. */
  readonly send: ExistingAgentMessaging["send"];
  readonly now: () => number;
  readonly newWaitId: () => string;
  /**
   * Durable Conversation surface (#P1, docs/conversation-and-message-io.md
   * §3.4): an awaited channel delegation opens its bounded reply window at
   * dispatch. Injected as a narrow port (never the store namespace) so the
   * driver stays testable without storage.
   */
  readonly conversations: {
    readonly open: typeof ConversationStore.open;
    readonly get: typeof ConversationStore.get;
  };
}

export interface ChannelDelegationDriver extends DelegationDriver {
  prepare(admitted: Admitted, handle: Delegation.Handle): DriverPreparation;
}

function waitForAbort(signal: AbortSignal): Promise<DriverOutcome> {
  if (signal.aborted) return Promise.resolve({ status: "cancelled", reason: "delegation stopped" });
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve({ status: "cancelled", reason: "delegation stopped" }),
      { once: true },
    );
  });
}

/**
 * Channel transport only. Correlation and settlement live in the kernel:
 * there is deliberately no in-memory pending map here. `prepare` allocates
 * the wait id before record creation; `run` opens/sends that exact Wait and
 * reports only transport acceptance or a delivery failure.
 */
export function createChannelDriver(ports: ChannelDriverPorts): ChannelDelegationDriver {
  return {
    prepare(admitted) {
      if (admitted.request.address.kind !== "actor") {
        throw new Error("channel transport carries actor addresses only");
      }
      return admitted.request.operation === "notify" ? {} : { waitId: ports.newWaitId() };
    },

    async run(
      admitted: Admitted,
      handle: Delegation.Handle,
      signal: AbortSignal,
      report?: DriverReport,
    ): Promise<DriverOutcome> {
      if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
      const address = admitted.request.address;
      if (address.kind !== "actor") {
        throw new Error("channel transport carries actor addresses only");
      }

      // §3.5 lease pin: a worker's admitted channel delegation carries the
      // lease that admitted it, and every send it produces is pinned to that
      // lease AND its conversation — the send kernel debits the carved
      // allocation durably before delivery. Lease sends are conversation
      // traffic, so even a notify rides the converse class.
      const lease = admitted.lease;
      const common = {
        messageId: handle.delegationId,
        traceId: delegationTraceId(handle.delegationId),
        senderId: "resident",
        target: { actorId: address.actorId },
        body: renderInstruction(
          admitted.request.payload.text,
          admitted.request.acceptanceCriteria ?? [],
        ),
        at: ports.now(),
        ...(lease === undefined
          ? {}
          : { leaseId: lease.id, conversationId: lease.conversationId }),
      } as const;

      let input: Gateway.SendInput;
      if (admitted.request.operation === "notify") {
        input = {
          ...common,
          operation: "fire_and_forget",
          class: lease === undefined ? "notify" : "converse",
        };
      } else {
        const waitId = handle.waitId;
        if (waitId === undefined) {
          throw new Error("awaited channel delegation reached dispatch without its prepared waitId");
        }
        input = {
          ...common,
          operation: "awaited",
          class: "converse",
          waitSpec: {
            waitId,
            ownerRef: { kind: "session", id: admitted.childOrigin.sessionId },
            allowedActions: ["report_result"],
            expectedResponders: [address.actorId],
            resolutionPolicy: "first_reply",
            // The Handle carries admission's min-clamped instant. No driver
            // clock or requested deadline is allowed to create another one.
            expiresAt: handle.deadline,
            followUpWindow: 0,
          },
        };
      }

      let receipt: Awaited<ReturnType<ExistingAgentMessaging["send"]>>;
      try {
        receipt = await ports.send(input);
      } catch (error) {
        return {
          status: "delivery_failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (receipt.kind === "denied") {
        return { status: "delivery_failed", reason: receipt.reason };
      }

      report?.delivered();
      if (admitted.request.operation === "notify") return { status: "sent" };

      // Bounded reply window (§3.4): the awaited ask opens its Conversation
      // AFTER transport acceptance — a window must never exist for a message
      // that never left. The id is the deterministic `conv:<waitId>`, the
      // expiry is the wait deadline, and the endpoint pin comes from the
      // admitted delivery target. A replayed dispatch finds the window
      // already open and reuses it (idempotent).
      if (receipt.operation !== "awaited") {
        throw new Error("awaited channel delegation settled without its wait — kernel regressed");
      }
      if (lease !== undefined) {
        // A lease send already lives inside its conversation — the reply
        // window exists and its caps govern; never open a second window.
        return waitForAbort(signal);
      }
      const conversationId = `conv:${receipt.wait.id}`;
      const existing = ports.conversations.get(conversationId);
      if (existing === undefined) {
        ports.conversations.open(
          {
            id: conversationId,
            contactId: receipt.target.actorId,
            endpointId: receipt.target.endpointId,
            ownerRef: { kind: "session", id: admitted.childOrigin.sessionId },
            openedBy: "delegate_ask",
            policy: {
              expiresAt: receipt.wait.expiresAt,
              maxOutbound: 8,
              maxInbound: 32,
              onInboundCapBreach: "demote",
            },
          },
          delegationTraceId(handle.delegationId),
        );
      } else if (existing.state === "closed") {
        // A replayed dispatch must never resurrect a settled window — the
        // conversation id is deterministic per wait, so a closed row under
        // it means the window already lived and died.
        throw new Error(`conversation ${conversationId} is already closed`);
      }

      // A reply enters DelegationKernel.settleFromReply through ingress. This
      // promise exists only to keep the dispatch alive until settlement,
      // cancellation, or deadline aborts its process-local controller.
      return waitForAbort(signal);
    },
  };
}
