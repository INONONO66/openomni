import type { Actor, Wait } from "@openomni/protocol";
import { ActorRegistry, Bus } from "@openomni/session";
import { WaitService } from "../wait/index.js";
import { Events } from "./events.js";
import {
  type DeliveryTarget,
  type MessageDenialCode,
  type MessageOperation,
  type MessageTarget,
  SendInput,
  type SendReceipt,
  type SenderTargetGrant,
  resolveSenderTargetGrant,
} from "./schema.js";

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

export type MessagingPorts = Readonly<{
  /**
   * Concrete delivery owner (server channel / API / connector). Required at
   * construction — there is no ownerless send path, so "no owner" cannot be
   * silently skipped (fail-closed, rule 7).
   */
  deliver: (message: OutboundMessage) => void;
  /** Policy-plane grant source; evaluated fresh on every send. */
  grants: () => readonly SenderTargetGrant[];
}>;

export type ExistingAgentMessaging = Readonly<{
  send: (input: SendInput) => SendReceipt;
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
    Bus.publish(Events.Denied, {
      messageId: input.messageId,
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

  function send(rawInput: SendInput): SendReceipt {
    const input = SendInput.parse(rawInput);
    const grant = resolveSenderTargetGrant(ports.grants(), {
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      operation: input.operation,
      at: input.at,
    });
    if (grant === undefined) {
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
      wait = WaitService.open({
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
      });
    }

    ports.deliver({
      messageId: input.messageId,
      senderId: input.senderId,
      operation: input.operation,
      body: input.body,
      target: resolution.target,
      ...(wait === undefined ? {} : { waitId: wait.id }),
    });
    Bus.publish(Events.Sent, {
      messageId: input.messageId,
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
