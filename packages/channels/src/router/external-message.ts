import { ActorRegistry, EgressBudgetStore, SurfaceKey } from "@openomni/ledger";
import type { PolicyEvaluationInput } from "@openomni/policy";
import { Channel, type Gateway } from "@openomni/protocol";
import { newTraceId } from "../support/trace";
import { resolveChannelGrant } from "./channel-grant";
import { resolveIngressActor } from "./actor-resolver";
import { isAuthorizedTopLevelActor } from "./authority-actor";
import { resolveAndRecordRoute } from "./routing-resolution";
import type { GatewayRouterPorts } from "./message-ports";
import { evaluateSocialBudget } from "./messaging/social-budget";

/** Only raw driver facts enter this projection; every authority field is resolved here. */
export function externalMessage(
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts,
  sink: GatewayRouterPorts["sink"],
  at: number,
  budgets: readonly Gateway.SocialBudget[],
) {
  if (sender.surface !== facts.surface) throw new Error("authenticated surface mismatch");
  const surfaceKey = Channel.SurfaceKey.fromChannel({
    surface: facts.surface,
    namespace: facts.workspaceId ?? facts.surface,
    kind: facts.dm ? "dm" : "channel",
    id: facts.channelId,
    ...(facts.reply?.threadId === undefined ? {} : { threadId: facts.reply.threadId }),
  });
  const reply = facts.reply ?? { chain: [] };
  if (
    sender.surface === "ws" &&
    ActorRegistry.resolveEndpoint("ws", sender.externalId) === undefined &&
    resolveChannelGrant({ surface: "ws", sender: sender.externalId })?.grant.defaultTier === "owner"
  ) {
    const actorId = `ws:owner:${sender.externalId}`;
    ActorRegistry.registerIdentity({ id: actorId, kind: "human", trustTier: "owner" });
    ActorRegistry.registerEndpoint({
      id: `ws:${sender.externalId}`,
      actorId,
      channel: "ws",
      externalId: sender.externalId,
    });
  }
  const event = resolveIngressActor({
    id: [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId]
      .map(encodeURIComponent)
      .join(":"),
    traceId: newTraceId(),
    surface: facts.surface,
    ...(facts.workspaceId === undefined ? {} : { workspace: facts.workspaceId }),
    channel: facts.channelId,
    userId: sender.externalId,
    payload: facts.payload,
    mode: "direct",
    meta: {
      surfaceKey,
      actor: { id: sender.externalId, role: "user" },
      correlation: {
        ...reply,
        endpointId:
          ActorRegistry.resolveEndpoint(sender.surface, sender.externalId, facts.workspaceId)
            ?.endpoint.id ?? `${sender.surface}:${sender.externalId}`,
        channelId: facts.channelId,
        externalConversationId: reply.externalConversationId ?? surfaceKey,
      },
    },
  });
  const route = resolveAndRecordRoute(event, surfaceKey, event.traceId, sink);
  const identities = facts.addressees.flatMap((addressee) => {
    const resolved = ActorRegistry.resolveEndpoint(
      sender.surface,
      addressee.externalId,
      facts.workspaceId,
    );
    return resolved === undefined ? [] : [resolved.identity];
  });
  const addressee =
    facts.dm || identities.some((identity) => identity.kind === "resident")
      ? "bot"
      : identities.some((identity) => identity.trustTier === "owner")
        ? "owner"
        : "ambient";
  const target = route.decision.sessionId ?? SurfaceKey.lookup(surfaceKey) ?? crypto.randomUUID();
  const actorId = event.meta?.actor?.actorId;
  const budget = budgets.find((candidate) => candidate.targetActorId === actorId);
  // Table A applies declared peer restrictions to unrelated ingress, without
  // charging a send. Correlated answers retain the existing reply exemption.
  const egressBudget =
    route.waitExecution.kind === "wait" ||
    budget === undefined ||
    evaluateSocialBudget(
      budget,
      EgressBudgetStore.read(target, budget.targetActorId, at - budget.windowMs),
      {
        class: "converse",
        at,
      },
    ) === "allow";
  const message: NonNullable<PolicyEvaluationInput["message"]> = {
    sender: "external",
    ...(route.decision.trustTier === undefined ? {} : { senderTier: route.decision.trustTier }),
    addressee,
    identity: route.decision.outcome === "route",
    grantTier:
      route.decision.outcome === "route" &&
      (route.waitExecution.kind === "wait" || isAuthorizedTopLevelActor(route.event)),
    egressBudget,
    eventIdUnique: true,
    replyCorrelation: route.decision.outcome !== "ambiguous",
  };
  return { route, event, target, surfaceKey, message, content: facts.render };
}
