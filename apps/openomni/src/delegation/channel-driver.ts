import type { ExistingAgentMessaging } from "@openomni/channels";
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
      } as const;

      let input: Gateway.SendInput;
      if (admitted.request.operation === "notify") {
        input = { ...common, operation: "fire_and_forget", class: "notify" };
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

      // A reply enters DelegationKernel.settleFromReply through ingress. This
      // promise exists only to keep the dispatch alive until settlement,
      // cancellation, or deadline aborts its process-local controller.
      return waitForAbort(signal);
    },
  };
}
