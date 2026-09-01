import {
  Gateway,
  MessagingEvents,
  Wait as WaitProtocol,
  type Actor,
  type BusEvent,
  type Conversation,
  type Lease,
  type Wait,
} from "@openomni/protocol";
import {
  ActorRegistry,
  ConversationStore,
  EgressBudgetStore,
  LedgerAppend,
  LeaseStore,
  WaitStore,
} from "@openomni/ledger";
import { WaitService } from "../wait/index.js";
import { matchBlacklist } from "../blacklist.js";
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
   * silently skipped (fail-closed, rule 7). At-least-once delivery: retries
   * carry the same `message.idempotencyKey` so a concrete owner can provide
   * bounded dedupe or platform read-back; the guarantee remains at-least-once
   * when composition does not forward the key.
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

/**
 * Reads the window a conversation-pinned send claims. A missing or closed
 * window reads as "no conversation arm" ONLY after the gate below refuses —
 * so this lookup stays a plain read and the typed denial happens in one
 * place (conversationGate) with the target resolved.
 */
function conversationForSend(input: SendInput): Conversation.Record | undefined {
  if (input.conversationId === undefined) return undefined;
  return ConversationStore.get(input.conversationId);
}

/** Reads the lease a lease-pinned send claims (same read-then-gate discipline). */
function leaseForSend(input: SendInput): Lease.Record | undefined {
  if (input.leaseId === undefined) return undefined;
  return LeaseStore.get(input.leaseId);
}

/**
 * The conversational send right (§3.4): the window must be open, unexpired,
 * and pinned to THIS actor at THIS endpoint; the absolute blacklist deny
 * (DNC) still binds. Returns the denial reason, or undefined when admitted.
 */
function conversationGate(
  conversationId: string,
  conversation: Conversation.Record | undefined,
  target: DeliveryTarget,
): string | undefined {
  if (conversation === undefined) {
    return `conversation ${conversationId} does not exist`;
  }
  if (conversation.state !== "open") {
    return `conversation ${conversationId} is closed (${conversation.closedBy ?? "unknown"})`;
  }
  if (conversation.contactId !== target.actorId || conversation.endpointId !== target.endpointId) {
    return `conversation ${conversationId} is not pinned to ${target.actorId} at ${target.endpointId}`;
  }
  const dnc = matchBlacklist({
    actorId: target.actorId,
    endpointId: target.endpointId,
    channel: target.channel,
    candidates: [target.channel],
  });
  if (dnc !== undefined) {
    return `conversation ${conversationId} target is blacklisted (${dnc.kind})`;
  }
  return undefined;
}

/** The grant stamp a conversation- or lease-pinned send carries on its audit events. */
function pinnedGrant(input: SendInput, id: string): SenderTargetGrant {
  return {
    id,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operations: [input.operation],
  };
}

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
  const appended = ledger.append({ streamId, type: SEND_ADMITTED_FACT, data: { ...admission } }, 0);
  if (appended.kind === "appended") return admission;
  const raced = existingAdmission(input, target);
  if (raced === undefined) {
    throw new Error(`send admission conflicted without a recorded fact on ${streamId}`);
  }
  return raced;
}

function debitRow(input: SendInput, sendClass: MessageClass): Gateway.EgressDebitRow {
  return {
    id: `gateway-send:${input.messageId}`,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    class: sendClass,
    at: input.at,
  };
}

type DenySend = (input: SendInput, code: MessageDenialCode, reason: string) => SendReceipt;

interface AuthorizedSend {
  readonly input: SendInput;
  readonly target: DeliveryTarget;
  readonly grant: SenderTargetGrant;
  readonly conversationPinned: boolean;
  readonly leasePinned: boolean;
  readonly conversation: Conversation.Record | undefined;
  readonly lease: Lease.Record | undefined;
}

/** Resolves sender authority and its exact allocated endpoint without mutating durable state. */
function authorizeSend(
  input: SendInput,
  ports: MessagingPorts,
  deny: DenySend,
): AuthorizedSend | SendReceipt {
  const grants = ports.grants();
  const claim = {
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operation: input.operation,
    at: input.at,
  };
  const conversationPinned = input.conversationId !== undefined;
  const leasePinned = input.leaseId !== undefined;
  const conversation = conversationForSend(input);
  const lease = leaseForSend(input);
  let grant: SenderTargetGrant | undefined;
  if (!conversationPinned && !leasePinned) {
    grant = resolveSenderTargetGrant(grants, claim);
    if (grant === undefined && !hasScopedSenderTargetCandidate(grants, claim)) {
      return deny(
        input,
        "ungranted",
        `no active sender-target grant covers ${input.senderId} -> ${input.target.actorId} (${input.operation})`,
      );
    }
  }
  const resolution = resolveExistingTarget(input.target);
  if (!resolution.ok) return deny(input, resolution.code, resolution.reason);

  if (leasePinned) {
    const leaseResult = authorizeLeaseSend(
      input,
      resolution.target,
      lease,
      conversationPinned,
      deny,
    );
    if ("kind" in leaseResult) return leaseResult;
    grant = leaseResult;
  } else if (conversationPinned) {
    const conversationDenial = conversationGate(
      input.conversationId ?? "",
      conversation,
      resolution.target,
    );
    if (conversationDenial !== undefined) {
      return deny(input, "conversation_denied", conversationDenial);
    }
    grant = pinnedGrant(input, `conversation:${input.conversationId ?? ""}`);
  } else if (grant === undefined) {
    const surfaceKey = deliverySurfaceKey(resolution.target);
    grant = resolveScopedSenderTargetGrant(grants, { ...claim, surfaceKey });
    if (grant === undefined) {
      return deny(
        input,
        "ungranted",
        `reply-scoped grant does not cover surface ${surfaceKey} — replies stay inside the initiating container`,
      );
    }
  }

  return {
    input,
    target: resolution.target,
    grant,
    conversationPinned,
    leasePinned,
    conversation,
    lease,
  };
}

function authorizeLeaseSend(
  input: SendInput,
  target: DeliveryTarget,
  lease: Lease.Record | undefined,
  conversationPinned: boolean,
  deny: DenySend,
): SenderTargetGrant | SendReceipt {
  const leaseId = input.leaseId ?? "";
  if (lease === undefined) return deny(input, "lease_denied", `lease ${leaseId} does not exist`);
  if (conversationPinned && input.conversationId !== lease.conversationId) {
    return deny(
      input,
      "lease_denied",
      `lease ${leaseId} scopes conversation ${lease.conversationId}, not ${input.conversationId ?? ""}`,
    );
  }
  const conversationDenial = conversationGate(
    lease.conversationId,
    ConversationStore.get(lease.conversationId),
    target,
  );
  if (conversationDenial !== undefined) {
    return deny(input, "conversation_denied", conversationDenial);
  }
  return pinnedGrant(input, `lease:${leaseId}`);
}

/** Records all admission debits before the delivery effect. */
function admitSend(
  authorization: AuthorizedSend,
  ports: MessagingPorts,
  deny: DenySend,
): SendAdmission | SendReceipt {
  const { input, target, grant, conversationPinned, leasePinned } = authorization;
  const sendClass = sendClassOf(input);
  let admission: SendAdmission | undefined;
  try {
    admission = existingAdmission(input, target);
  } catch (error) {
    if (error instanceof SendAdmissionConflict && input.operation === "awaited") {
      return deny(input, "wait_duplicate", error.message);
    }
    throw error;
  }
  if (admission !== undefined) {
    repairBudgetDebit(input, admission);
    return admission;
  }

  const budgeted =
    !conversationPinned &&
    !leasePinned &&
    ports.budgets !== undefined &&
    grant.replyScope === undefined;
  const pinnedDenial = debitPinnedAuthority(authorization, deny);
  if (pinnedDenial !== undefined) return pinnedDenial;
  if (budgeted) {
    const budget = ports
      .budgets?.()
      .find((candidate) => candidate.targetActorId === input.target.actorId);
    const budgetClaim = EgressBudgetStore.claim(
      debitRow(input, sendClass),
      input.at - (budget?.windowMs ?? 0),
      (state) => evaluateSocialBudget(budget, state, { class: sendClass, at: input.at }),
    );
    if (budgetClaim.kind === "refused") {
      return deny(
        input,
        budgetClaim.reason.suppress,
        `active-egress budget suppressed a ${sendClass} send ${input.senderId} -> ${input.target.actorId} (${budgetClaim.reason.suppress})`,
      );
    }
  }
  admission = recordAdmission(input, target, budgeted, sendClass);
  repairBudgetDebit(input, admission);
  return admission;
}

function debitPinnedAuthority(
  authorization: AuthorizedSend,
  deny: DenySend,
): SendReceipt | undefined {
  const { input, leasePinned, conversationPinned, lease, conversation } = authorization;
  if (leasePinned && lease !== undefined) {
    const debit = LeaseStore.sendDebit(lease.id, input.at);
    if (debit.kind === "refused") {
      return deny(
        input,
        "lease_denied",
        `lease ${lease.id} refused the outbound send (${debit.reason})`,
      );
    }
  } else if (conversationPinned && conversation !== undefined) {
    const debit = ConversationStore.admitOutbound(conversation.id, input.traceId, input.at);
    if (debit.kind === "refused") {
      return deny(
        input,
        "conversation_denied",
        `conversation ${conversation.id} refused the outbound send (${debit.reason})`,
      );
    }
  }
  return undefined;
}

function repairBudgetDebit(input: SendInput, admission: SendAdmission): void {
  if (!admission.budgeted) return;
  EgressBudgetStore.claim(debitRow(input, admission.sendClass), input.at, () => "allow");
}

type WaitOpening =
  | { readonly ok: true; readonly wait: Wait.Record | undefined }
  | { readonly ok: false; readonly receipt: SendReceipt };

/** Opens or resumes the awaited-send record before delivery. */
function openSendWait(input: SendInput, target: DeliveryTarget, deny: DenySend): WaitOpening {
  if (input.operation !== "awaited") return { ok: true, wait: undefined };
  // SendInput's refinement requires waitSpec for awaited sends.
  const spec = input.waitSpec as NonNullable<SendInput["waitSpec"]>;
  try {
    const wait = WaitService.open(
      {
        id: spec.waitId,
        ownerRef: spec.ownerRef,
        originMessageId: input.messageId,
        correlation: {
          ...spec.correlation,
          endpointId: target.endpointId,
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
    return { ok: true, wait };
  } catch (error) {
    if (WaitProtocol.StoreError.isInstance(error)) {
      if (error.data.code !== "duplicate") throw error;
      const recorded = WaitStore.get(spec.waitId);
      if (recorded?.originMessageId === input.messageId) return { ok: true, wait: recorded };
      return {
        ok: false,
        receipt: deny(
          input,
          "wait_duplicate",
          `a different Wait already exists for message ${input.messageId} or wait ${spec.waitId}`,
        ),
      };
    }
    throw error;
  }
}

/** Delivers under the stable idempotency key and records external correlation when present. */
async function deliverSend(
  input: SendInput,
  target: DeliveryTarget,
  wait: Wait.Record | undefined,
  ports: MessagingPorts,
): Promise<Wait.Record | undefined> {
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
          target,
          ...(wait === undefined ? {} : { waitId: wait.id }),
        })
      : { externalMessageId: recordedExternalId };
  if (wait === undefined || delivery?.externalMessageId === undefined) return wait;
  const receipt = WaitService.recordDeliveryReceipt(
    wait.id,
    { externalMessageId: delivery.externalMessageId, at: input.at },
    input.traceId,
  );
  return receipt.kind === "delivery_recorded" ? receipt.record : wait;
}

function recordSent(
  authorization: AuthorizedSend,
  wait: Wait.Record | undefined,
  ports: MessagingPorts,
): SendReceipt {
  const { input, target, grant, leasePinned, lease } = authorization;
  ports.publish(MessagingEvents.Sent, {
    messageId: input.messageId,
    traceId: input.traceId,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operation: input.operation,
    grantId: grant.id,
    endpointId: target.endpointId,
    ...(wait === undefined ? {} : { waitId: wait.id }),
    ...(leasePinned && lease !== undefined
      ? { onBehalfOf: lease.holderDelegationId, via: `lease:${lease.id}` }
      : {}),
    time: input.at,
  });
  if (wait !== undefined) {
    return {
      kind: "sent",
      operation: "awaited",
      messageId: input.messageId,
      senderId: input.senderId,
      grantId: grant.id,
      target,
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
    target,
    at: input.at,
  };
}

export function createExistingAgentMessaging(ports: MessagingPorts): ExistingAgentMessaging {
  function deny(input: SendInput, code: MessageDenialCode, reason: string): SendReceipt {
    ports.publish(MessagingEvents.Denied, {
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
    const authorization = authorizeSend(input, ports, deny);
    if ("kind" in authorization) return authorization;
    const { target } = authorization;

    const admission = admitSend(authorization, ports, deny);
    if ("kind" in admission) return admission;

    const waitOpening = openSendWait(input, target, deny);
    if (!waitOpening.ok) return waitOpening.receipt;
    const wait = await deliverSend(input, target, waitOpening.wait, ports);
    return recordSent(authorization, wait, ports);
  }

  return { send };
}
