import {
  Gateway,
  Wait as WaitProtocol,
  type Actor,
  type BusEvent,
  type Wait,
} from "@openomni/protocol";
import {
  ActorRegistry,
  EgressBudgetStore,
  LedgerAppend,
  WaitStore,
} from "@openomni/ledger";
import { WaitService } from "../wait/index.js";
import { Events } from "./events.js";
import {
  deliverySurfaceKey,
  hasScopedSenderTargetCandidate,
  resolveScopedSenderTargetGrant,
  resolveSenderTargetGrant,
} from "./grant.js";
import { evaluateSocialBudget } from "./social-budget.js";

type DeliveryTarget = Gateway.DeliveryTarget;
type MessageClass = Gateway.MessageClass;
type MessageDenialCode = Gateway.MessageDenialCode;
type MessageOperation = Gateway.MessageOperation;
type MessageTarget = Gateway.MessageTarget;
const SendInput = Gateway.SendInput;
type SendInput = Gateway.SendInput;
type SendReceipt = Gateway.SendReceipt;
type SenderTargetGrant = Gateway.SenderTargetGrant;
type SocialBudget = Gateway.SocialBudget;

/** Policy-intent class of a send, inferred from `operation` when not explicit (#219). */
function sendClassOf(input: SendInput): MessageClass {
  return input.class ?? (input.operation === "awaited" ? "converse" : "notify");
}

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
  /** Stable gateway idempotency key. Delivery owners must reconcile/dedupe retries under this key. */
  idempotencyKey: string;
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
  /**
   * At-least-once delivery: retries carry the same `message.idempotencyKey` so
   * a concrete owner can provide bounded dedupe or platform read-back. The
   * guarantee remains at-least-once when composition does not forward the key.
   */
  deliver: (
    message: OutboundMessage,
    // biome-ignore lint/suspicious/noConfusingVoidType: `void` admits receipt-less synchronous owners (e.g. test collectors) without forcing a dummy `return undefined`
  ) => void | DeliveryReceipt | Promise<DeliveryReceipt | undefined>;
  /** Policy-plane grant source; evaluated fresh on every send. */
  grants: () => readonly SenderTargetGrant[];
  /**
   * Owner-declared active-egress budget source (#219), evaluated fresh on
   * every send — the HOW-OFTEN axis, orthogonal to `grants` (the MAY-I axis).
   * OPTIONAL: when absent the #219 gate is entirely bypassed (pure additive,
   * backward-compat — existing sends behave exactly as before). When present,
   * the gate engages and the fail-safe default applies: a COLD-proactive send
   * to a target with no budget entry is suppressed `budget_exhausted`. Replies
   * (reply-scoped grant instances) always bypass the gate.
   */
  budgets?: () => readonly SocialBudget[];
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

const SEND_ADMITTED_FACT = "gateway.send.admitted";

type SendAdmission = Readonly<{
  signature: string;
  budgeted: boolean;
  sendClass: MessageClass;
}>;

class SendAdmissionConflict extends Error {}

function sendStreamId(messageId: string): string {
  return `gateway_send:${encodeURIComponent(messageId)}`;
}

function sendSignature(input: SendInput, target: DeliveryTarget): string {
  return JSON.stringify({
    messageId: input.messageId,
    senderId: input.senderId,
    operation: input.operation,
    class: input.class,
    body: input.body,
    target,
    waitSpec: input.waitSpec,
  });
}

function parseAdmission(data: unknown, streamId: string): SendAdmission {
  if (
    typeof data !== "object" ||
    data === null ||
    !("signature" in data) ||
    typeof data.signature !== "string" ||
    !("budgeted" in data) ||
    typeof data.budgeted !== "boolean" ||
    !("sendClass" in data) ||
    (data.sendClass !== "notify" && data.sendClass !== "converse")
  ) {
    throw new Error(`corrupt send admission fact on ${streamId}`);
  }
  return {
    signature: data.signature,
    budgeted: data.budgeted,
    sendClass: data.sendClass,
  };
}

function existingAdmission(input: SendInput, target: DeliveryTarget): SendAdmission | undefined {
  const ledger = LedgerAppend.port();
  if (ledger === undefined) {
    throw new Error("Storage adapter does not implement ledger append — gateway sends fail closed");
  }
  const streamId = sendStreamId(input.messageId);
  const fact = ledger.headFact(streamId);
  if (fact === undefined) return undefined;
  if (fact.type !== SEND_ADMITTED_FACT) {
    throw new Error(`unexpected fact type on send stream ${streamId}: ${fact.type}`);
  }
  const admission = parseAdmission(fact.data, streamId);
  if (admission.signature !== sendSignature(input, target)) {
    throw new SendAdmissionConflict(
      `message id ${input.messageId} was already admitted with different content`,
    );
  }
  return admission;
}

function recordAdmission(
  input: SendInput,
  target: DeliveryTarget,
  budgeted: boolean,
  sendClass: MessageClass,
): SendAdmission {
  const ledger = LedgerAppend.port();
  if (ledger === undefined) {
    throw new Error("Storage adapter does not implement ledger append — gateway sends fail closed");
  }
  const streamId = sendStreamId(input.messageId);
  const admission = { signature: sendSignature(input, target), budgeted, sendClass } as const;
  const appended = ledger.append(
    { streamId, type: SEND_ADMITTED_FACT, data: { ...admission } },
    0,
  );
  if (appended.kind === "appended") return admission;
  const raced = existingAdmission(input, target);
  if (raced === undefined) {
    throw new Error(`send admission conflicted without a recorded fact on ${streamId}`);
  }
  return raced;
}

function recordDebitOnce(input: SendInput, sendClass: MessageClass): void {
  try {
    EgressBudgetStore.record({
      id: `gateway-send:${input.messageId}`,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      class: sendClass,
      at: input.at,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    ) {
      return;
    }
    throw error;
  }
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

    // A durable admission marker distinguishes a retry from a new send before
    // any mutable budget/Wait state is revisited. It is also the immutable
    // binding from messageId to content + resolved endpoint: reusing a key for
    // different bytes fails closed.
    const sendClass = sendClassOf(input);
    let admission: SendAdmission | undefined;
    try {
      admission = existingAdmission(input, resolution.target);
    } catch (error) {
      if (error instanceof SendAdmissionConflict && input.operation === "awaited") {
        return deny(input, "wait_duplicate", error.message);
      }
      throw error;
    }
    if (admission === undefined) {
      // #219 active-egress gate: evaluate only for a NEW admission. A resumed
      // send already passed this judgment and must not consume capacity twice.
      const budgeted = ports.budgets !== undefined && grant.replyScope === undefined;
      if (budgeted) {
        const budget = ports
          .budgets?.()
          .find((candidate) => candidate.targetActorId === input.target.actorId);
        const state =
          budget === undefined
            ? { countInWindow: 0, notifyInWindow: 0, converseInWindow: 0 }
            : EgressBudgetStore.readState(
                input.senderId,
                input.target.actorId,
                input.at - budget.windowMs,
              );
        const verdict = evaluateSocialBudget(budget, state, { class: sendClass, at: input.at });
        if (verdict !== "allow") {
          return deny(
            input,
            verdict.suppress,
            `active-egress budget suppressed a ${sendClass} send ${input.senderId} -> ${input.target.actorId} (${verdict.suppress})`,
          );
        }
      }
      admission = recordAdmission(input, resolution.target, budgeted, sendClass);
    }
    if (admission.budgeted) {
      // Deterministic identity closes both sides of the admission/debit crash
      // window: missing debit is appended; an already-recorded debit is a
      // proven resume and changes no budget count.
      recordDebitOnce(input, admission.sendClass);
    }
    // #219 escalation seam (DEFERRED, out of this PR): the autonomous
    // timer-fired 봉수 rung-advance would attach its counting coordinate HERE —
    // blocked by the #469 accumulator + a missing periodic-timeout firing
    // source. The synchronous suppression gate above ships without it.

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
        if (WaitProtocol.StoreError.isInstance(error) && error.data.code === "duplicate") {
          const recorded = WaitStore.get(spec.waitId);
          if (recorded?.originMessageId === input.messageId) {
            wait = recorded;
          } else {
            return deny(
              input,
              "wait_duplicate",
              `a different Wait already exists for message ${input.messageId} or wait ${spec.waitId}`,
            );
          }
        } else {
          throw error;
        }
      }
    }

    // A recorded external correlation is durable proof that the effect and
    // receipt CAS completed. Otherwise call the owner under the stable key;
    // its contract requires API idempotency/read-back reconciliation.
    const recordedExternalId =
      wait !== undefined && wait.correlation.replyToMessageId !== input.messageId
        ? wait.correlation.replyToMessageId
        : undefined;
    const delivery =
      recordedExternalId === undefined
        ? await ports.deliver({
            messageId: input.messageId,
            idempotencyKey: input.messageId,
            senderId: input.senderId,
            operation: input.operation,
            body: input.body,
            target: resolution.target,
            ...(wait === undefined ? {} : { waitId: wait.id }),
          })
        : { externalMessageId: recordedExternalId };
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
