import type { ExistingAgentMessaging } from "@openomni/channels";
import type { Delegation } from "@openomni/protocol";
import type { Admitted } from "./admission";
import { renderInstruction } from "./instruction";
import type { DelegationDriver, DriverOutcome } from "./kernel";

export interface ChannelDriverPorts {
  /**
   * The gateway's #215 send kernel, resolved late because the driver is
   * composed before the gateway that owns it. Every grant/target/budget
   * judgment lives behind this port — the driver only carries the request.
   */
  readonly send: ExistingAgentMessaging["send"];
  readonly now: () => number;
  readonly newWaitId: () => string;
}

/**
 * The channel transport plus its resume half: `run` sends the instruction to
 * an external actor as an awaited message, `resume` is called by the ingress
 * bridge when the perimeter correlates that actor's reply back to the Wait.
 */
export interface ChannelDelegationDriver extends DelegationDriver {
  /** True when the waitId belonged to a delegation still awaiting its reply. */
  resume(waitId: string, text: string): boolean;
}

/**
 * The channel transport: delegation to an actor who lives OUTSIDE this
 * process — a human or an external agent on a channel. The send kernel owns
 * every authority judgment (grants, target resolution, budgets) and the
 * durable Wait; this driver owns only the mapping between that machinery and
 * the delegation contract's settlement vocabulary.
 */
export function createChannelDriver(ports: ChannelDriverPorts): ChannelDelegationDriver {
  const pending = new Map<string, (text: string | undefined) => void>();

  return {
    resume(waitId, text) {
      const settle = pending.get(waitId);
      if (settle === undefined) return false;
      pending.delete(waitId);
      settle(text);
      return true;
    },

    async run(admitted: Admitted, handle: Delegation.Handle, signal: AbortSignal): Promise<DriverOutcome> {
      const address = admitted.request.address;
      if (address.kind !== "actor") {
        // Admission maps only actor addresses onto this transport; reaching
        // here with anything else is a composition fault, not a worker answer.
        throw new Error("channel transport carries actor addresses only");
      }

      const waitId = ports.newWaitId();
      // Registered BEFORE the send: the reply can race the send's own return,
      // and a reply that finds no pending entry would fall through to the
      // Resident as an ordinary message instead of settling this delegation.
      const reply = new Promise<string | undefined>((resolve) => {
        pending.set(waitId, resolve);
      });
      const abort = () => {
        const settle = pending.get(waitId);
        if (settle !== undefined) {
          pending.delete(waitId);
          settle(undefined);
        }
      };
      signal.addEventListener("abort", abort, { once: true });

      let receipt: Awaited<ReturnType<ExistingAgentMessaging["send"]>>;
      try {
        receipt = await ports.send({
          messageId: handle.delegationId,
          traceId: handle.delegationId,
          senderId: "resident",
          target: { actorId: address.actorId },
          operation: "awaited",
          body: renderInstruction(
            admitted.request.payload.text,
            admitted.request.acceptanceCriteria ?? [],
          ),
          at: ports.now(),
          waitSpec: {
            waitId,
            ownerRef: { kind: "session", id: admitted.childOrigin.sessionId },
            allowedActions: ["report_result"],
            expectedResponders: [address.actorId],
            resolutionPolicy: "first_reply",
            expiresAt: admitted.request.deadline,
            followUpWindow: 0,
          },
        });
      } catch (error) {
        // The delivery effect itself broke (no live connection, transport
        // fault): the actor never held the request. The Wait the kernel may
        // have opened expires on its own schedule — send.ts blesses exactly
        // this ordering ("a delivery failure leaves an open Wait").
        pending.delete(waitId);
        signal.removeEventListener("abort", abort);
        return {
          status: "delivery_failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      if (receipt.kind === "denied") {
        pending.delete(waitId);
        signal.removeEventListener("abort", abort);
        return { status: "delivery_failed", reason: receipt.reason };
      }

      const text = await reply;
      signal.removeEventListener("abort", abort);
      // The kernel aborts on deadline and settles no_response itself; the
      // driver only stops holding the pending entry.
      if (text === undefined) return { status: "cancelled", reason: "deadline reached" };
      return { status: "completed", output: text };
    },
  };
}
