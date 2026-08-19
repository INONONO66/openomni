import { Gateway, Operational, type BusEvent } from "@openomni/protocol";
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
 * RULING (#708): instances are IN-MEMORY on the router for this stage. A
 * restart forgets them and the initiator's next admitted message
 * re-materializes an instance under the same rule — no new persisted surface
 * lands here; the durable grant-instance store is the #709/SSOT follow-up.
 */

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
}>;

export type ReplyGrantInstances = Readonly<{
  /** Live view for the send kernel's grant source; expiry is re-checked per-send by the evaluator (`at` is the send's clock). */
  list(): readonly Gateway.SenderTargetGrant[];
  /** Materializes instances for an admitted inbound; capacity/first-contact rules applied per rule. */
  admit(admission: ReplyGrantAdmission): void;
}>;

function ruleCovers(rule: Gateway.ReplyGrantRule, admission: ReplyGrantAdmission): boolean {
  return (
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
  let instances: Gateway.SenderTargetGrant[] = [];

  /** Memory hygiene only — authority-expiry is the evaluator's per-send check. */
  function prune(at: number): void {
    instances = instances.filter(
      (instance) => instance.expiresAt === undefined || at <= instance.expiresAt,
    );
  }

  return {
    list() {
      return [...instances];
    },

    admit(admission: ReplyGrantAdmission): void {
      prune(admission.at);
      for (const rule of ports.rules()) {
        if (!ruleCovers(rule, admission)) continue;
        // The persona never needs a grant to be replied to by itself.
        if (rule.senderId === admission.actorId) continue;
        const surfaceKey = deliverySurfaceKey(admission.endpoint);
        const liveForRule = instances.filter((instance) => instance.ruleId === rule.id);
        const alreadyLive = liveForRule.some(
          (instance) =>
            instance.targetActorId === admission.actorId &&
            instance.replyScope?.surfaceKey === surfaceKey,
        );
        // First contact only: a live instance for this initiator+container
        // keeps its ORIGINAL expiry — repeat messages never refresh it.
        if (alreadyLive) continue;
        if (liveForRule.length >= rule.maxLiveInstances) {
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
        }
        // Parse pins the schema invariants (rule-materialized ⇒ replyScope +
        // expiresAt) — a drifting materializer fails loudly, not silently.
        const instance = Gateway.SenderTargetGrant.parse({
          id: crypto.randomUUID(),
          senderId: rule.senderId,
          targetActorId: admission.actorId,
          operations: [...rule.operations],
          expiresAt: admission.at + rule.instanceTtlMs,
          ruleId: rule.id,
          replyScope: { surfaceKey },
        } satisfies Gateway.SenderTargetGrant);
        instances.push(instance);
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
      }
    },
  };
}
