import { Gateway, Operational, type BusEvent } from "@openomni/protocol";
import { ReplyGrantStore } from "@openomni/ledger";
import { deliverySurfaceKey } from "./grant.js";

/**
 * Reply-grant materialization (#708, stage-0 rule of docs/gateway-design.md
 * §2b): the Owner writes a *rule* row (surface/channel-scoped standing
 * delegation); the gateway materializes bounded `SenderTargetGrant`
 * INSTANCES from it mechanically when it admits a first-contact actor on the
 * covered channel. Instances are scoped by perimeter facts only — initiator
 * actorId + originating endpoint surface key + `instanceTtlMs` expiry —
 * never by engagement id, and `maxLiveInstances` caps grant farming by mass
 * first contact.
 *
 * Instances are one indexed durable current projection of committed admissions.
 * Construction never replays history; channels alone normalizes perimeter facts.
 */

const ENDPOINT_CHANNEL_FACT_PREFIX = "reply_grant.endpoint.channel:";
const ENDPOINT_EXTERNAL_ID_FACT_PREFIX = "reply_grant.endpoint.external_id:";

export function replyGrantEndpointFacts(endpoint: Readonly<{ channel: string; externalId: string }>) {
	return [
		`${ENDPOINT_CHANNEL_FACT_PREFIX}${encodeURIComponent(endpoint.channel)}`,
		`${ENDPOINT_EXTERNAL_ID_FACT_PREFIX}${encodeURIComponent(endpoint.externalId)}`,
	] as const;
}

export function replyGrantEndpointFromFacts(
	facts: readonly string[],
): Readonly<{ channel: string; externalId: string }> | undefined {
	const channels = facts.filter((fact) => fact.startsWith(ENDPOINT_CHANNEL_FACT_PREFIX));
	const externalIds = facts.filter((fact) => fact.startsWith(ENDPOINT_EXTERNAL_ID_FACT_PREFIX));
	if (channels.length !== 1 || externalIds.length !== 1) return undefined;
	try {
		const channel = decodeURIComponent(channels[0]?.slice(ENDPOINT_CHANNEL_FACT_PREFIX.length) ?? "");
		const externalId = decodeURIComponent(
			externalIds[0]?.slice(ENDPOINT_EXTERNAL_ID_FACT_PREFIX.length) ?? "",
		);
		if (channel === "" || externalId === "") return undefined;
		return { channel, externalId };
	} catch {
		return undefined;
	}
}

export type ReplyGrantAdmission = Readonly<{
	/** Resolved registered initiator (perimeter fact — anonymous senders materialize nothing). */
	actorId: string;
	/** The initiator's resolved endpoint — the same facts the send kernel re-derives at evaluation. */
	endpoint: Readonly<{ channel: string; externalId: string }>;
	surface: string;
	workspace?: string;
	channel?: string;
	traceId: string;
	at: number;
	/** Committed admission identity; makes retry instance ids stable. */
	sourceId?: string;
}>;

export type ReplyGrantInstances = Readonly<{
	/** Live view for the send kernel's grant source; expiry is re-checked per-send by the evaluator (`at` is the send's clock). */
	list(at?: number): readonly Gateway.SenderTargetGrant[];
	/** Materializes instances for an admitted inbound; capacity/first-contact rules applied per rule. */
	admit(admission: ReplyGrantAdmission): void;
}>;

function ruleCovers(rule: Gateway.ReplyGrantRule, admission: ReplyGrantAdmission): boolean {
	return (
		(rule.createdAt === undefined || admission.at >= rule.createdAt) &&
		rule.surface === admission.surface &&
		(rule.workspace === undefined || rule.workspace === admission.workspace) &&
		(rule.channel === undefined || rule.channel === admission.channel)
	);
}

export function createReplyGrantInstances(ports: {
	readonly rules: () => readonly Gateway.ReplyGrantRule[];
	/** Injected observation sink — materialization and capacity refusals are audited, never silent. */
	readonly publish: BusEvent.Sink["publish"];
}): ReplyGrantInstances {
	function admit(admission: ReplyGrantAdmission): void {
		for (const rule of ports.rules()) {
			if (!ruleCovers(rule, admission)) continue;
			// The persona never needs a grant to be replied to by itself.
			if (rule.senderId === admission.actorId) continue;
			const surfaceKey = deliverySurfaceKey(admission.endpoint);
			const sourceId = admission.sourceId ??
				JSON.stringify([admission.actorId, surfaceKey, admission.at]);
			const instance = {
				id: `reply-grant:${encodeURIComponent(rule.id)}:${encodeURIComponent(sourceId)}`,
				senderId: rule.senderId,
				targetActorId: admission.actorId,
				operations: [...rule.operations],
				expiresAt: admission.at + rule.instanceTtlMs,
				ruleId: rule.id,
				replyScope: { surfaceKey },
			} satisfies Gateway.SenderTargetGrant;
			Gateway.SenderTargetGrant.parse(instance);
			// First contact, expiry and the cap are atomic across router instances.
			const result = ReplyGrantStore.claim(instance, {
				at: admission.at, maxLiveInstances: rule.maxLiveInstances,
			});
			switch (result) {
				case "existing": continue;
				case "capacity":
					ports.publish(Operational.Events.Warn, {
						traceId: admission.traceId,
						time: admission.at,
						component: "gateway",
						msg: "reply-grant rule at capacity; no instance materialized",
						context: {
							ruleId: rule.id,
							targetActorId: admission.actorId,
							surfaceKey,
							maxLiveInstances: rule.maxLiveInstances,
						},
					});
					continue;
				case "claimed":
					ports.publish(Operational.Events.Info, {
						traceId: admission.traceId,
						time: admission.at,
						component: "gateway",
						msg: "reply-grant instance materialized",
						context: {
							ruleId: rule.id,
							instanceId: instance.id,
							senderId: rule.senderId,
							targetActorId: admission.actorId,
							surfaceKey,
							expiresAt: instance.expiresAt,
						},
					});
					break;
			}
		}
	}

	return {
		list(at = Date.now()) {
			return ReplyGrantStore.listLive(at);
		},
		admit,
	};
}
