import { ActorRegistry, SurfaceKey } from "@openomni/ledger";
import type { PolicyEvaluationInput } from "@openomni/policy";
import { Channel, type Gateway } from "@openomni/protocol";
import { newTraceId } from "../support/trace";
import { resolveChannelGrant } from "./channel-grant";
import { resolveIngressActor } from "./actor-resolver";
import { resolveAndRecordRoute } from "./routing-resolution";
import type { GatewayRouterPorts } from "./message-ports";

/** Only raw driver facts enter this projection; every authority field is resolved here. */
export function externalMessage(
	sender: Extract<Gateway.IngestSender, { kind: "external" }>,
	facts: Gateway.IngressFacts,
	sink: GatewayRouterPorts["sink"],
) {
	if (sender.surface !== facts.surface) throw new Error("authenticated surface mismatch");
	const surfaceKey = Channel.SurfaceKey.fromChannel({
		surface: facts.surface,
		namespace: facts.workspaceId ?? facts.surface,
		kind: facts.dm ? "dm" : "channel",
		id: facts.channelId,
		...(facts.reply?.threadId === undefined ? {} : { threadId: facts.reply.threadId }),
	});
	const { chain: _chain, ...reply } = facts.reply ?? { chain: [] };
	if (sender.surface === "ws" && ActorRegistry.resolveEndpoint("ws", sender.externalId) === undefined
		&& resolveChannelGrant({ surface: "ws", sender: sender.externalId })?.grant.defaultTier === "owner") {
		const actorId = "ws:owner:" + sender.externalId;
		ActorRegistry.registerIdentity({ id: actorId, kind: "human", trustTier: "owner" });
		ActorRegistry.registerEndpoint({ id: "ws:" + sender.externalId, actorId, channel: "ws", externalId: sender.externalId });
	}
	const event = resolveIngressActor({
		id: [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId].map(encodeURIComponent).join(":"),
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
				...(reply.replyToMessageId === undefined && facts.reply?.chain[0] !== undefined ? { replyToMessageId: facts.reply.chain[0] } : {}),
				endpointId: ActorRegistry.resolveEndpoint(sender.surface, sender.externalId, facts.workspaceId)?.endpoint.id
					?? `${sender.surface}:${sender.externalId}`,
				channelId: facts.channelId,
				externalConversationId: reply.externalConversationId ?? surfaceKey,
			},
		},
	});
	const route = resolveAndRecordRoute(event, event.traceId, sink);
	const identities = facts.addressees.flatMap((addressee) => {
		const resolved = ActorRegistry.resolveEndpoint(sender.surface, addressee.externalId, facts.workspaceId);
		return resolved === undefined ? [] : [resolved.identity];
	});
	const addressee = facts.dm || identities.some((identity) => identity.kind === "resident")
		? "bot" : identities.some((identity) => identity.trustTier === "owner") ? "owner" : "ambient";
	const message: NonNullable<PolicyEvaluationInput["message"]> = {
		sender: "external",
		...(route.decision.trustTier === undefined ? {} : { senderTier: route.decision.trustTier }),
		addressee,
		identity: route.decision.outcome === "route",
		grantTier: route.decision.outcome === "route",
		egressBudget: true,
		eventIdUnique: true,
		replyCorrelation: route.decision.outcome !== "ambiguous",
	};
	const target = route.decision.sessionId ?? SurfaceKey.lookup(surfaceKey) ?? crypto.randomUUID();
	return { route, event, target, surfaceKey, message, content: facts.render };
}
