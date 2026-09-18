import { Gateway, type DecisionFact } from "@openomni/protocol";
import { EgressBudgetStore, DecisionFacts } from "@openomni/ledger";
import { z } from "zod";
import type { GatewayRouterPorts } from "../message-ports";
import { evaluateSocialBudget } from "./social-budget";

const SEND_ADMITTED_FACT = "gateway.send.admitted";
const SendAdmission = z.object({
  signature: z.string(),
  budgeted: z.boolean(),
  sendClass: Gateway.MessageClass,
});
type SendAdmission = z.infer<typeof SendAdmission>;
class SendAdmissionConflict extends Error {}

interface AuthorizedSend {
  readonly input: Gateway.SendInput;
  readonly target: Gateway.DeliveryTarget;
  readonly grant: Gateway.SenderTargetGrant;
}

type DenySend = (
  input: Gateway.SendInput,
  code: Gateway.MessageDenialCode,
  reason: string,
) => Gateway.SendReceipt;

function sendSignature(input: Gateway.SendInput, target: Gateway.DeliveryTarget): string {
  return JSON.stringify({
    messageId: input.messageId,
    senderId: input.senderId,
    operation: input.operation,
    class: input.class,
    body: input.body,
    target,
    requestSpec: input.requestSpec,
  });
}

function sendStreamId(messageId: string): string {
  return `gateway_send:${encodeURIComponent(messageId)}`;
}

function existingAdmission(
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
): SendAdmission | SendAdmissionConflict | undefined {
  const decisionFacts = DecisionFacts.port();
  if (decisionFacts === undefined)
    throw new Error(
      "Storage adapter does not implement decision facts — gateway sends fail closed",
    );
  const fact = decisionFacts.head(sendStreamId(input.messageId));
  return fact === undefined ? undefined : recordedAdmission(fact, input, target);
}

function recordedAdmission(
  fact: DecisionFact.Recorded,
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
): SendAdmission | SendAdmissionConflict {
  const streamId = fact.key;
  if (fact.type !== SEND_ADMITTED_FACT)
    throw new Error(`unexpected fact type on send stream ${streamId}: ${fact.type}`);
  const parsed = SendAdmission.safeParse(fact.data);
  if (!parsed.success) throw new Error(`corrupt send admission fact on ${streamId}`);
  const admission = parsed.data;
  if (admission.signature !== sendSignature(input, target)) {
    return new SendAdmissionConflict(
      `message id ${input.messageId} was already admitted with different content`,
    );
  }
  return admission;
}

function recordAdmission(
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
  budgeted: boolean,
  sendClass: Gateway.MessageClass,
): SendAdmission {
  const decisionFacts = DecisionFacts.port();
  if (decisionFacts === undefined)
    throw new Error(
      "Storage adapter does not implement decision facts — gateway sends fail closed",
    );
  const key = sendStreamId(input.messageId);
  const admission = { signature: sendSignature(input, target), budgeted, sendClass } as const;
  const outcome = decisionFacts.record({
    key,
    type: SEND_ADMITTED_FACT,
    data: { ...admission },
    timeCreated: input.at,
  });
  if (outcome.kind === "recorded") return admission;
  const raced = recordedAdmission(outcome.fact, input, target);
  if (raced instanceof SendAdmissionConflict) throw raced;
  return raced;
}

function debitRow(
  input: Gateway.SendInput,
  sendClass: Gateway.MessageClass,
): Gateway.EgressDebitRow {
  return {
    id: `gateway-send:${input.messageId}`,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    class: sendClass,
    at: input.at,
  };
}

function repairBudgetDebit(input: Gateway.SendInput, admission: SendAdmission): void {
  if (!admission.budgeted) return;
  EgressBudgetStore.claim(debitRow(input, admission.sendClass), input.at, () => "allow");
}

/** Runs synchronously inside the caller's ledger transaction, before any physical delivery. */
export function admitSend(
  authorization: AuthorizedSend,
  ports: Pick<NonNullable<GatewayRouterPorts["messaging"]>, "budgets">,
  deny: DenySend,
): SendAdmission | Gateway.SendReceipt {
  const { input, target, grant } = authorization;
  const sendClass = input.class ?? (input.operation === "awaited" ? "converse" : "notify");
  let admission = existingAdmission(input, target);
  if (admission instanceof SendAdmissionConflict) {
    if (input.operation === "awaited") return deny(input, "request_duplicate", admission.message);
    throw admission;
  }
  if (admission !== undefined) {
    repairBudgetDebit(input, admission);
    return admission;
  }
  const budgeted = ports.budgets !== undefined && grant.replyScope === undefined;
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
