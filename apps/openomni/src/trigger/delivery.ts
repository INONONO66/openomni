import { LedgerAppend } from "@openomni/ledger";
import { Gateway, Ingress, Trigger } from "@openomni/protocol";
import type { ResidentDelivery } from "../resident";
import { buildPendingReservation } from "./notifier";
import type { TriggerClock } from "./scheduler";

class InternalTriggerRouteError extends Error {
  constructor(
    readonly code: "route_record_failed" | "route_replay_divergent",
    message: string,
  ) {
    super(message);
    this.name = "InternalTriggerRouteError";
  }
}

export interface InternalRoutePort {
  append: NonNullable<ReturnType<typeof LedgerAppend.port>>["append"];
  headFact: NonNullable<ReturnType<typeof LedgerAppend.port>>["headFact"];
}

function buildInternalTriggerDelivery(fire: Trigger.Fire): Gateway.InternalDeliver {
  return Gateway.InternalDeliver.parse({
    sessionId: fire.ownerSessionId,
    event: {
      id: fire.id,
      traceId: fire.traceId,
      surface: "internal",
      mode: "internal",
      agentName: "resident",
      target: { kind: "resident", sessionId: fire.ownerSessionId },
      payload: fire.payload,
      meta: {
        actor: { role: "system", id: "system:trigger" },
        kind: "trigger.fire",
        triggerId: fire.triggerId,
        fireId: fire.id,
      },
      activation: {
        trigger: {
          kind: fire.scheduledForAt === undefined ? "internal" : "cron",
          id: fire.triggerId,
          fireId: fire.id,
          ...(fire.scheduledForAt === undefined
            ? {}
            : { scheduledAt: fire.scheduledForAt }),
          firedAt: fire.firedAt,
          attempt: fire.deliveryAttempts,
        },
      },
    },
    decision: {
      traceId: fire.traceId,
      time: fire.recordedAt,
      inboundId: fire.id,
      surface: "internal",
      mode: "internal",
      stage: "surface_default",
      outcome: "route",
      reason: "durable Trigger Fire",
      factsUsed: [`trigger:${fire.triggerId}`, `trigger_fire:${fire.id}`],
      target: `resident:${fire.ownerSessionId}`,
      sessionId: fire.ownerSessionId,
    },
  });
}

/** Record-before-act for the internal app arm, with the same replay gate as channels. */
function recordInternalTriggerRoute(
  delivery: Gateway.InternalDeliver,
  port: InternalRoutePort | undefined = LedgerAppend.port(),
): void {
  if (port === undefined) {
    throw new InternalTriggerRouteError(
      "route_record_failed",
      "Storage adapter does not implement ledger append — internal Trigger routing fails closed",
    );
  }
  const streamId = Ingress.routeStreamId(delivery.event);
  let outcome: ReturnType<InternalRoutePort["append"]>;
  try {
    outcome = port.append(Ingress.routeDecidedFact(streamId, delivery.decision), 0);
  } catch (error) {
    throw new InternalTriggerRouteError(
      "route_record_failed",
      `internal Trigger route append failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (outcome.kind === "appended") return;

  let recorded: Ingress.RoutingDecisionPayload | undefined;
  try {
    const fact = port.headFact(streamId);
    if (fact?.type !== Ingress.ROUTE_DECIDED_FACT_TYPE) {
      throw new Error(`stream ${streamId} has no route.decided head`);
    }
    recorded = Ingress.recordedRoutingDecision(fact.data);
  } catch (error) {
    throw new InternalTriggerRouteError(
      "route_record_failed",
      `internal Trigger route replay failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    recorded === undefined ||
    !Ingress.routeDecisionsEquivalent(recorded, delivery.decision)
  ) {
    throw new InternalTriggerRouteError(
      "route_replay_divergent",
      "redelivered Trigger Fire diverges from its recorded route decision",
    );
  }
}

export interface TriggerRecordStorePort {
  get(triggerId: string): Trigger.Record | undefined;
}

export interface TriggerFireStorePort {
  get(fireId: string): Trigger.Fire | undefined;
  claimDeliveryAttempt(input: {
    fireId: string;
    expectedFireRevision: number;
    traceId: string;
    at: number;
  }): Trigger.Fire;
  markDelivered(input: {
    fireId: string;
    expectedFireRevision: number;
    traceId: string;
    at: number;
  }): Trigger.Fire;
  ack(input: {
    fireId: string;
    expectedFireRevision: number;
    expectedTriggerRevision: number;
    admission: Trigger.FireAdmission;
    nextReservation?: {
      pendingFingerprint: Trigger.CanonicalDigest;
      reservation: Trigger.FireReservation;
    };
    traceId: string;
    at: number;
  }): { fire: Trigger.Fire; trigger: Trigger.Record; nextFire?: Trigger.Fire };
}

export interface TriggerDeliveryDeps {
  readonly clock: TriggerClock;
  readonly triggers: TriggerRecordStorePort;
  readonly fires: TriggerFireStorePort;
  readonly resident: ResidentDelivery;
  readonly route?: InternalRoutePort;
  readonly newFireId: () => string;
  readonly newTraceId: () => string;
  /** Queue insertion receipt only; never waits for the nested Resident run. */
  readonly enqueue: (fire: Trigger.Fire) => void | Promise<void>;
}

export interface TriggerDelivery {
  deliver(fireId: string): Promise<Ingress.IngressResult | undefined>;
}

function missingRecord(kind: "Trigger" | "Trigger Fire", id: string): Error {
  return new Trigger.StoreError({
    code: "not_found",
    ...(kind === "Trigger" ? { triggerId: id } : { fireId: id }),
    message: `${kind} not found: ${id}`,
  });
}

function isRevisionConflict(error: unknown): boolean {
  return Trigger.StoreError.isInstance(error) && error.data.code === "revision_conflict";
}

/**
 * Fire delivery bridge. Route acceptance precedes delivered CAS; deterministic
 * Resident admission precedes ack; a pending replacement is queued only after
 * its reservation commits in the composite ack transaction.
 */
export function createTriggerDelivery(deps: TriggerDeliveryDeps): TriggerDelivery {
  async function acknowledge(admission: Trigger.FireAdmission): Promise<void> {
    // Owner-session serialization normally makes the first attempt win. The
    // bounded rebuild handles one concurrent notifier coalesce without ever
    // reusing stale pending rendering.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fire = deps.fires.get(admission.fireId);
      if (fire === undefined) throw missingRecord("Trigger Fire", admission.fireId);
      if (fire.status === "acked") return;
      const trigger = deps.triggers.get(fire.triggerId);
      if (trigger === undefined) throw missingRecord("Trigger", fire.triggerId);
      const nextReservation =
        trigger.pendingBatch === undefined
          ? undefined
          : {
              pendingFingerprint: trigger.pendingBatch.fingerprint,
              reservation: buildPendingReservation({
                trigger,
                fireId: deps.newFireId(),
                traceId: deps.newTraceId(),
              }),
            };
      const at = Math.max(
        deps.clock.now(),
        fire.updatedAt,
        trigger.lastObservedAt,
        admission.admittedAt,
      );
      try {
        const receipt = deps.fires.ack({
          fireId: fire.id,
          expectedFireRevision: fire.revision,
          expectedTriggerRevision: trigger.revision,
          admission,
          ...(nextReservation === undefined ? {} : { nextReservation }),
          traceId: fire.traceId,
          at,
        });
        if (receipt.nextFire !== undefined) await deps.enqueue(receipt.nextFire);
        return;
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 2) throw error;
      }
    }
  }

  return {
    async deliver(fireId) {
      let fire = deps.fires.get(fireId);
      if (fire === undefined) throw missingRecord("Trigger Fire", fireId);
      if (fire.status === "acked") return undefined;
      const trigger = deps.triggers.get(fire.triggerId);
      if (trigger === undefined) throw missingRecord("Trigger", fire.triggerId);

      if (fire.status === "recorded") {
        const attemptAt = Math.max(deps.clock.now(), fire.updatedAt, trigger.lastObservedAt);
        fire = deps.fires.claimDeliveryAttempt({
          fireId: fire.id,
          expectedFireRevision: fire.revision,
          traceId: fire.traceId,
          at: attemptAt,
        });
      }

      const delivery = buildInternalTriggerDelivery(fire);
      recordInternalTriggerRoute(delivery, deps.route);

      if (fire.status === "recorded") {
        const deliveredAt = Math.max(deps.clock.now(), fire.updatedAt, trigger.lastObservedAt);
        fire = deps.fires.markDelivered({
          fireId: fire.id,
          expectedFireRevision: fire.revision,
          traceId: fire.traceId,
          at: deliveredAt,
        });
      }

      return deps.resident.deliverInternal(delivery, acknowledge);
    },
  };
}
