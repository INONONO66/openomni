import {
  Gateway,
  Wait as WaitProtocol,
  type Actor,
  type BusEvent,
  type Wait,
} from "@openomni/protocol";
import { ActorRegistry } from "@openomni/ledger";
import { WaitService } from "../wait/index.js";
import { Events } from "./events.js";
import {
  deliverySurfaceKey,
  hasScopedSenderTargetCandidate,
  resolveScopedSenderTargetGrant,
  resolveSenderTargetGrant,
} from "./grant.js";

type DeliveryTarget = Gateway.DeliveryTarget;
type MessageDenialCode = Gateway.MessageDenialCode;
type MessageOperation = Gateway.MessageOperation;
type MessageTarget = Gateway.MessageTarget;
const SendInput = Gateway.SendInput;
type SendInput = Gateway.SendInput;
type SendReceipt = Gateway.SendReceipt;
type SenderTargetGrant = Gateway.SenderTargetGrant;

/**
 * Existing-agent messaging service (#215). One send reaches exactly one
 * already-allocated actor endpoint or fails closed with a typed denial —
 * grant first, then target resolution, then delivery. Awaited delivery
 * appends exactly one Wait via WaitService.open; fire-and-forget records the
 * audit event only. This module allocates nothing: it never touches
 * WorkItem/Worker/session/executor/budget stores, and the driver's
 * `allocationDelta: 0` receipt plus the messaging test suite pin that.
 */

export type OutboundMessage = Readonly<{
  messageId: string;
  senderId: string;
  operation: MessageOperation;
  body: string;
  target: DeliveryTarget;
  waitId?: string;
}>;

/**
 * What the concrete delivery owner reports back: the platform message id,
 * when the channel API returns one. Returning nothing is valid (channels
 * without message ids) — the wait correlation then keeps the internal id.
 */
export type DeliveryReceipt = Readonly<{ externalMessageId?: string }>;

export type MessagingPorts = Readonly<{
  /**
   * Concrete delivery owner (server channel / API / connector). Required at
   * construction — there is no ownerless send path, so "no owner" cannot be
   * silently skipped (fail-closed, rule 7).
   */
  deliver: (
    message: OutboundMessage,
    // biome-ignore lint/suspicious/noConfusingVoidType: `void` admits receipt-less synchronous owners (e.g. test collectors) without forcing a dummy `return undefined`
  ) => void | DeliveryReceipt | Promise<DeliveryReceipt | undefined>;
  /** Policy-plane grant source; evaluated fresh on every send. */
  grants: () => readonly SenderTargetGrant[];
  /** Injected observation sink (messaging.sent / messaging.denied) — channels never imports the observation channel. */
  publish: BusEvent.Sink["publish"];
}>;

export type ExistingAgentMessaging = Readonly<{
  send: (input: SendInput) => Promise<SendReceipt>;
}>;

type TargetDenialCode = Extract<
  MessageDenialCode,
  "target_missing" | "target_stale" | "target_ambiguous"
>;

type TargetResolution =
  | Readonly<{ ok: true; target: DeliveryTarget }>
  | Readonly<{ ok: false; code: TargetDenialCode; reason: string }>;

function deliveryTarget(actorId: string, endpoint: Actor.Endpoint): DeliveryTarget {
  return {
    actorId,
    endpointId: endpoint.id,
    channel: endpoint.channel,
    externalId: endpoint.externalId,
  };
}

/**
 * Resolves the explicit target to ONE allocated actor endpoint:
 * - unknown actorId               -> target_missing
 * - pinned endpoint gone/re-bound -> target_stale (the reference outlived the allocation)
 * - actor without any endpoint    -> target_stale
 * - several endpoints, no pin     -> target_ambiguous (resolution never guesses)
 */
function resolveExistingTarget(target: MessageTarget): TargetResolution {
  const identity = ActorRegistry.getIdentity(target.actorId);
  if (identity === undefined) {
    return {
      ok: false,
      code: "target_missing",
      reason: `actor ${target.actorId} is not a registered identity`,
    };
  }
  if (target.endpointId !== undefined) {
    const endpoint = ActorRegistry.getEndpoint(target.endpointId);
    if (endpoint === undefined) {
      return {
        ok: false,
        code: "target_stale",
        reason: `pinned endpoint ${target.endpointId} no longer exists`,
      };
    }
    if (endpoint.actorId !== target.actorId) {
      return {
        ok: false,
        code: "target_stale",
        reason: `pinned endpoint ${target.endpointId} no longer belongs to ${target.actorId}`,
      };
    }
    return { ok: true, target: deliveryTarget(target.actorId, endpoint) };
  }
  const endpoints = ActorRegistry.listEndpoints(target.actorId);
  const [endpoint, ...rest] = endpoints;
  if (endpoint === undefined) {
    return {
      ok: false,
      code: "target_stale",
      reason: `actor ${target.actorId} has no allocated endpoint`,
    };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      code: "target_ambiguous",
      reason: `actor ${target.actorId} is reachable at ${endpoints.length} endpoints — pin target.endpointId`,
    };
  }
  return { ok: true, target: deliveryTarget(target.actorId, endpoint) };
}

export function createExistingAgentMessaging(ports: MessagingPorts): ExistingAgentMessaging {
  function deny(input: SendInput, code: MessageDenialCode, reason: string): SendReceipt {
    ports.publish(Events.Denied, {
      messageId: input.messageId,
      traceId: input.traceId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      code,
      time: input.at,
    });
    return {
      kind: "denied",
      code,
      messageId: input.messageId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      reason,
      at: input.at,
    };
  }

  async function send(rawInput: SendInput): Promise<SendReceipt> {
    const input = SendInput.parse(rawInput);
    const grants = ports.grants();
    const claim = {
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      operation: input.operation,
      at: input.at,
    };
    // Scope-aware arm (#708): a rule-materialized instance carries a
    // replyScope that can only be checked against the RESOLVED delivery
    // endpoint, so with a candidate present the target resolves first and
    // the scope check follows. With no candidate the denial stays
    // `ungranted` BEFORE any registry lookup — an ungranted sender learns
    // nothing from the registry (pinned by the send suite).
    let grant = resolveSenderTargetGrant(grants, claim);
    if (grant === undefined && !hasScopedSenderTargetCandidate(grants, claim)) {
      return deny(
        input,
        "ungranted",
        `no active sender-target grant covers ${input.senderId} -> ${input.target.actorId} (${input.operation})`,
      );
    }
    const resolution = resolveExistingTarget(input.target);
    if (!resolution.ok) {
      return deny(input, resolution.code, resolution.reason);
    }
    if (grant === undefined) {
      const surfaceKey = deliverySurfaceKey(resolution.target);
      grant = resolveScopedSenderTargetGrant(grants, { ...claim, surfaceKey });
      if (grant === undefined) {
        // Cross-surface use of a reply-scoped instance fails closed: the
        // instance authorizes replies INTO the initiating container only.
        return deny(
          input,
          "ungranted",
          `reply-scoped grant does not cover surface ${surfaceKey} — replies stay inside the initiating container`,
        );
      }
    }

    // #219 seam: egress semantics (social budget, notify|converse class
    // split, 봉수 escalation counting) evaluate HERE — after grant, before
    // the wait record and the delivery effect. Own leaf, not this PR.

    let wait: Wait.Record | undefined;
    if (input.operation === "awaited") {
      const spec = input.waitSpec;
      // Presence is guaranteed by the SendInput refinement; this narrows the
      // optional type without a silent fallback.
      if (spec === undefined) {
        throw new Error("awaited send without waitSpec — schema layer regressed");
      }
      // Record-before-act: the durable Wait lands before the delivery effect.
      // A delivery failure then leaves an open Wait that expires on schedule;
      // the reverse order could deliver a message the ledger never awaits.
      try {
        wait = WaitService.open(
          {
            id: spec.waitId,
            ownerRef: spec.ownerRef,
            originMessageId: input.messageId,
            correlation: {
              ...spec.correlation,
              endpointId: resolution.target.endpointId,
              replyToMessageId: input.messageId,
            },
            allowedActions: spec.allowedActions,
            expectedResponders: spec.expectedResponders,
            resolutionPolicy: spec.resolutionPolicy,
            ...(spec.quorum === undefined ? {} : { quorum: spec.quorum }),
            expiresAt: spec.expiresAt,
            followUpWindow: spec.followUpWindow,
            createdAt: input.at,
            updatedAt: input.at,
          },
          input.traceId,
        );
      } catch (error) {
        // Exactly-once awaited delivery surfacing as a typed denial: the
        // ledger already awaits this message (or wait id), so this send
        // delivers nothing and changes nothing. Every other StoreError
        // (adapter_absent, ...) stays a thrown fail-closed error.
        if (WaitProtocol.StoreError.isInstance(error) && error.data.code === "duplicate") {
          return deny(
            input,
            "wait_duplicate",
            `a Wait already exists for message ${input.messageId} or wait ${spec.waitId} — awaited delivery is exactly-once`,
          );
        }
        throw error;
      }
    }

    const delivery = await ports.deliver({
      messageId: input.messageId,
      senderId: input.senderId,
      operation: input.operation,
      body: input.body,
      target: resolution.target,
      ...(wait === undefined ? {} : { waitId: wait.id }),
    });
    if (wait !== undefined && delivery !== undefined && delivery.externalMessageId !== undefined) {
      // The channel returned the platform message id: re-key the wait's
      // correlation.replyToMessageId to it so real platform replies (which
      // reference the platform id, not our internal one) correlate. A wait
      // that turned terminal while the delivery was in flight rejects the
      // receipt (wait_terminal) and keeps its recorded correlation.
      const receipt = WaitService.recordDeliveryReceipt(
        wait.id,
        { externalMessageId: delivery.externalMessageId, at: input.at },
        input.traceId,
      );
      if (receipt.kind === "delivery_recorded") wait = receipt.record;
    }
    ports.publish(Events.Sent, {
      messageId: input.messageId,
      traceId: input.traceId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      operation: input.operation,
      grantId: grant.id,
      endpointId: resolution.target.endpointId,
      ...(wait === undefined ? {} : { waitId: wait.id }),
      time: input.at,
    });

    if (wait !== undefined) {
      return {
        kind: "sent",
        operation: "awaited",
        messageId: input.messageId,
        senderId: input.senderId,
        grantId: grant.id,
        target: resolution.target,
        wait,
        at: input.at,
      };
    }
    return {
      kind: "sent",
      operation: "fire_and_forget",
      messageId: input.messageId,
      senderId: input.senderId,
      grantId: grant.id,
      target: resolution.target,
      at: input.at,
    };
  }

  return { send };
}
