import { canonicalDigest, Gateway, SessionTransition } from "@openomni/protocol";
import { ActorRegistry } from "@openomni/ledger";
import { matchBlacklist } from "../blacklist";
import type { GatewayRouterPorts } from "../message-ports";

/** Authenticate and normalize only. The injected kernel owns every transition. */
export async function answerOwnerRequest(
  ports: GatewayRouterPorts,
  sender: Gateway.IngestSender,
  envelope: Gateway.RequestAnswer,
  receivedAt: number,
): Promise<Gateway.IngestResult> {
  if (sender.kind === "session") {
    return { status: "blocked_pre", reasonCode: "request_answer.session_sender" };
  }
  const parsed = Gateway.RequestAnswer.safeParse(envelope);
  if (!parsed.success) {
    return { status: "blocked_pre", reasonCode: "request_answer.invalid" };
  }
  if (ports.authenticateAnswer === undefined) {
    return { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" };
  }
  const { inputId, request, decision, credential } = parsed.data;
  if (canonicalDigest(request.parsedInput) !== request.inputHash) {
    return { status: "blocked_pre", reasonCode: "request_answer.rejected" };
  }
  let principal: SessionTransition.Principal;
  try {
    principal = SessionTransition.Principal.parse(
      await ports.authenticateAnswer(sender, credential, request.requestId),
    );
    if (principal.kind !== "owner") {
      return { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" };
    }
  } catch {
    // Authentication failures can contain secrets; never forward their raw errors.
    return { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" };
  }
  const authenticatedAt = Math.max(receivedAt, (ports.clock ?? Date.now)());
  const endpoint = ActorRegistry.resolveEndpoint(sender.surface, sender.externalId);
  if (matchBlacklist({ actorId: endpoint?.identity.id ?? principal.principalId,
    endpointId: endpoint?.endpoint.id, channel: sender.surface,
    candidates: [sender.surface, sender.externalId],
  }, authenticatedAt) !== undefined) {
    return { status: "blocked_pre", reasonCode: "request_answer.blacklisted" };
  }
  const resolution = await ports.requests.answer({
    inputId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: authenticatedAt,
    principal,
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision,
    allowedAction: "report_result",
    content: decision,
  });
  if (resolution !== "resolved" && resolution !== "refused" && resolution !== "duplicate") {
    return { status: "blocked_pre", reasonCode: `request_answer.${resolution}` };
  }
  return {
    status: "executed",
    handle: { messageId: inputId, target: request.sessionId },
    delivery: { kind: "session" },
  };
}
