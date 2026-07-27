import { Execution, Ledger } from "@openomni/protocol";
import { nativeTransitionById, type TransitionEmissionV1 } from "../native-transitions.js";
import type { KernelTransitionCommandV1 } from "../ports.js";
import { assertGrantScheduleEffectTransition } from "./grant-schedule-effect.js";
import { workAttemptCompletionGuardReason } from "./work-attempt-completion.js";

const CONFIGURATION_EVENT_BY_OPERATION: Readonly<Record<string, Ledger.NativeEventTypeV1>> =
  Object.freeze({
    "AF-01": "artifact.referenced.v1",
    "AI-01": "actor.identity_registered.v1",
    "AI-02": "actor.identity_revised.v1",
    "AI-03": "actor.identity_retired.v1",
    "AE-01": "actor.endpoint_bound.v1",
    "AE-02": "actor.endpoint_rebound.v1",
    "AE-03": "actor.endpoint_unbound.v1",
    "BL-01": "authority.blacklist_created.v1",
    "BL-02": "authority.blacklist_revised.v1",
    "BL-03": "authority.blacklist_revoked.v1",
    "BL-04": "authority.blacklist_expired.v1",
    "CG-01": "authority.channel_grant_created.v1",
    "CG-02": "authority.channel_grant_revised.v1",
    "CG-03": "authority.channel_grant_revoked.v1",
    "CI-01": "connector.installation_registered.v1",
    "CI-02": "connector.definition_revised.v1",
    "CI-03": "connector.consent_requested.v1",
    "CI-04": "connector.consent_granted.v1",
    "CI-05": "connector.verification_requested.v1",
    "CI-06": "connector.verified.v1",
    "CI-07": "connector.verification_failed.v1",
    "CI-08": "connector.disabled.v1",
    "CI-09": "connector.uninstalled.v1",
  });

export class UnknownKernelTransitionError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(readonly transitionId: string) {
    super(`unknown closed kernel transition: ${transitionId}`);
    this.name = "UnknownKernelTransitionError";
  }
}

export interface PreparedKernelTransitionV1 {
  readonly command: KernelTransitionCommandV1;
  readonly eventTypes: readonly Ledger.NativeEventTypeV1[];
  readonly append: Ledger.AppendBatchRequestV1 | null;
}

export function parseClosedKernelCommand(input: unknown): KernelTransitionCommandV1 {
  const parsed = Execution.KernelTransitionCommandV1.safeParse(input);
  if (!parsed.success) {
    const transitionId =
      typeof input === "object" && input !== null && "transitionId" in input
        ? String(input.transitionId)
        : "unknown";
    throw new UnknownKernelTransitionError(transitionId);
  }
  return parsed.data;
}

function emittedTypes(command: KernelTransitionCommandV1): readonly Ledger.NativeEventTypeV1[] {
  const configurationType = CONFIGURATION_EVENT_BY_OPERATION[command.transitionId];
  if (configurationType !== undefined) return [configurationType];

  let emission: TransitionEmissionV1;
  try {
    emission = nativeTransitionById(command.transitionId).emission;
  } catch {
    throw new UnknownKernelTransitionError(command.transitionId);
  }
  const candidates =
    emission.kind === "batch"
      ? emission.eventTypes
      : emission.kind === "conditional-batch"
        ? "facts" in command.payload &&
          (command.payload.facts as Execution.NativeTransitionPayloadV1["facts"]).AT !== undefined
          ? emission.sourceRunEventTypes
          : emission.sourceNonRunEventTypes
        : emission.kind === "cross-owner"
          ? [
              ...emission.sourceEventTypes,
              ...emission.destinationEventTypes,
              ...emission.settlementEventTypes,
            ]
          : [];
  return candidates.map((eventType) => Ledger.NativeEventTypeV1.parse(eventType));
}

function eventFamily(eventType: Ledger.NativeEventTypeV1): string {
  if (eventType.startsWith("session.")) return "SS";
  if (eventType.startsWith("surface.")) return "SF";
  if (eventType.startsWith("message.")) return "MS";
  if (eventType.startsWith("kernel.route.")) return "RT";
  if (eventType.startsWith("dispatch.")) return "DP";
  if (eventType.startsWith("work.")) return "WI";
  if (eventType.startsWith("completion.")) return "CP";
  if (eventType.startsWith("attempt.")) return "AT";
  if (eventType.startsWith("wait.")) return "WT";
  if (eventType.startsWith("grant.")) return "GR";
  if (eventType.startsWith("schedule.")) return "SC";
  if (eventType.startsWith("effect.")) return "EF";
  if (eventType.startsWith("artifact.")) return "AF";
  if (eventType.startsWith("actor.identity_")) return "AI";
  if (eventType.startsWith("actor.endpoint_")) return "AE";
  if (eventType.startsWith("authority.blacklist_")) return "BL";
  if (eventType.startsWith("authority.channel_grant_")) return "CG";
  if (eventType.startsWith("connector.")) return "CI";
  throw new UnknownKernelTransitionError(eventType);
}

function nativeFactsForEvent(
  command: KernelTransitionCommandV1,
  eventType: Ledger.NativeEventTypeV1,
): object {
  if (!("facts" in command.payload)) throw new UnknownKernelTransitionError(command.transitionId);
  const facts: unknown = Reflect.get(command.payload.facts, eventFamily(eventType));
  if (typeof facts !== "object" || facts === null) {
    throw new UnknownKernelTransitionError(command.transitionId);
  }
  return facts;
}

export function projectNativeEventPayload(
  command: KernelTransitionCommandV1,
  eventType: Ledger.NativeEventTypeV1,
): Ledger.NativeEventPayloadV1 {
  if (!("facts" in command.payload)) {
    return Ledger.NativeEventPayloadV1.parse({
      version: "native-event-payload-v1",
      eventType,
      subjectId: Reflect.get(command.payload, "subjectId"),
      occurredAtDbMs: Reflect.get(command.payload, "occurredAtDbMs"),
      configurationSnapshotRef: Reflect.get(command.payload, "configurationSnapshotRef"),
    });
  }
  const payload = nativeFactsForEvent(command, eventType);
  const fact = (key: PropertyKey): unknown => Reflect.get(payload, key);
  const nestedFact = (value: unknown, key: PropertyKey): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const base = {
    version: "native-event-payload-v1" as const,
    eventType,
    subjectId: fact("subjectId"),
    occurredAtDbMs: fact("occurredAtDbMs"),
  };
  if (eventType.startsWith("kernel.route."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      sessionId: fact("sessionId"),
      surfaceId: fact("surfaceId"),
      messageId: fact("messageId"),
      routeId: fact("routeId"),
      routeDecision: fact("routeDecision"),
      authoritySnapshotRef: fact("authoritySnapshotRef"),
      routeSnapshotRef: fact("routeSnapshotRef"),
    });
  if (eventType.startsWith("dispatch.")) {
    const settlement = fact("settlement");
    const destinationReceiptRef = fact("destinationReceiptRef");
    const definiteFailureProofRef = fact("definiteFailureProofRef");
    if (
      (eventType === "dispatch.delivered.v1" &&
        (destinationReceiptRef === null || definiteFailureProofRef !== null)) ||
      (eventType === "dispatch.failed.v1" &&
        (destinationReceiptRef !== null || definiteFailureProofRef === null)) ||
      (eventType !== "dispatch.delivered.v1" &&
        eventType !== "dispatch.failed.v1" &&
        (destinationReceiptRef !== null || definiteFailureProofRef !== null))
    ) {
      throw new TypeError(`dispatch proof refs do not match ${eventType}`);
    }
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      dispatchId: fact("dispatchId"),
      routeId: fact("routeId"),
      sourceSessionId: fact("sourceSessionId"),
      sourceOwner: fact("sourceOwner"),
      destinationOwner: fact("destinationOwner"),
      dispatchDecision: fact("dispatchDecision"),
      settlement,
      dispatchSnapshotRef: fact("dispatchSnapshotRef"),
      destinationReceiptRef,
      definiteFailureProofRef,
    });
  }
  if (eventType.startsWith("session."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      sessionId: fact("sessionId"),
      parentSessionId: fact("parentSessionId"),
      model: fact("model"),
      sessionSnapshotRef: fact("sessionSnapshotRef"),
    });
  if (eventType.startsWith("surface."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      sessionId: fact("sessionId"),
      surfaceId: fact("surfaceId"),
      surfaceKind: fact("surfaceKind"),
      endpointId: fact("endpointId"),
      surfaceSnapshotRef: fact("surfaceSnapshotRef"),
    });
  if (eventType.startsWith("message."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      sessionId: fact("sessionId"),
      surfaceId: fact("surfaceId"),
      messageId: fact("messageId"),
      partId: fact("partId"),
      role: fact("role"),
      status: fact("status"),
      model: fact("model"),
      messageSnapshotRef: fact("messageSnapshotRef"),
      partSnapshotRef: fact("partSnapshotRef"),
    });
  if (eventType.startsWith("work."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      workItemId: fact("workItemId"),
      sessionId: fact("sessionId"),
      workSnapshotRef: fact("workSnapshotRef"),
    });
  if (eventType.startsWith("completion.")) {
    const candidateArtifactRef = fact("candidateArtifactRef");
    const verdictArtifactRef = fact("verdictArtifactRef");
    const admissionDecisionArtifactRef = fact("admissionDecisionArtifactRef");
    const verdictArtifactRefs = fact("verdictArtifactRefs");
    const verdictRefs = Array.isArray(verdictArtifactRefs) ? verdictArtifactRefs : [];
    const candidateDigest = nestedFact(candidateArtifactRef, "digest");
    if (candidateDigest !== fact("candidateId")) {
      throw new TypeError("completion candidate artifact ref does not match candidate identity");
    }
    if (
      (eventType === "completion.candidate.submitted.v1" &&
        (verdictRefs.length !== 0 ||
          verdictArtifactRef !== null ||
          admissionDecisionArtifactRef !== null)) ||
      (eventType === "completion.claim_verdict_recorded.v1" &&
        (verdictArtifactRef === null ||
          admissionDecisionArtifactRef !== null ||
          nestedFact(verdictRefs.at(-1), "digest") !== nestedFact(verdictArtifactRef, "digest"))) ||
      (eventType === "completion.candidate_rejected.v1" &&
        (verdictArtifactRef !== null || admissionDecisionArtifactRef !== null)) ||
      (eventType === "completion.decision_recorded.v1" &&
        (verdictArtifactRef !== null || admissionDecisionArtifactRef === null))
    ) {
      throw new TypeError(`completion artifact refs do not match ${eventType}`);
    }
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      workItemId: fact("workItemId"),
      candidateId: fact("candidateId"),
      runBindingRef: fact("runBindingRef"),
      completionSnapshotRef: fact("completionSnapshotRef"),
      candidateArtifactRef,
      verdictArtifactRef,
      admissionDecisionArtifactRef,
      verdictArtifactRefs,
    });
  }
  if (eventType.startsWith("attempt."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      workItemId: nestedFact(fact("attempt"), "workItemId"),
      attemptId: nestedFact(fact("attempt"), "attemptId"),
      attemptSeq: nestedFact(fact("attempt"), "attemptSeq"),
      sessionId: nestedFact(fact("runBinding"), "sessionId"),
      runId: nestedFact(fact("runBinding"), "runId"),
      model: fact("model"),
      environmentSnapshotRef: fact("environmentSnapshotRef"),
      attemptSnapshotRef: fact("attemptSnapshotRef"),
    });
  if (eventType.startsWith("wait."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      waitId: nestedFact(fact("waitEvent"), "waitId"),
      waitEventVersion: nestedFact(fact("waitEvent"), "version"),
      waitSnapshotRef: fact("waitSnapshotRef"),
    });
  if (eventType.startsWith("grant."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      grantId: fact("grantId"),
      workItemId: nestedFact(fact("attempt"), "workItemId"),
      attemptId: nestedFact(fact("attempt"), "attemptId"),
      granteeId: fact("granteeId"),
      grantScopeRef: fact("grantScopeRef"),
      grantSnapshotRef: fact("grantSnapshotRef"),
    });
  if (eventType.startsWith("schedule."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      scheduleId: fact("scheduleId"),
      generation: fact("generation"),
      nextFireRef: fact("nextFireRef"),
      settlementRef: fact("settlementRef"),
      scheduleSnapshotRef: fact("scheduleSnapshotRef"),
    });
  if (eventType.startsWith("effect."))
    return Ledger.NativeEventPayloadV1.parse({
      ...base,
      effectId: nestedFact(fact("effect"), "effectId"),
      idempotencyKey: nestedFact(fact("effect"), "idempotencyKey"),
      workItemId: nestedFact(fact("attempt"), "workItemId"),
      attemptId: nestedFact(fact("attempt"), "attemptId"),
      effectScopeRef: fact("effectScopeRef"),
      settlement: fact("settlement"),
      effectSettlementRef: fact("effectSettlementRef"),
    });
  throw new UnknownKernelTransitionError(command.transitionId);
}

function prepareFamilyBatch(command: KernelTransitionCommandV1): PreparedKernelTransitionV1 {
  const eventTypes = emittedTypes(command);
  if (eventTypes.length === 0) return { command, eventTypes, append: null };

  const owner = command.payload.owner;
  const principalId = command.identity.principalId;
  const events = eventTypes.map((eventType, index) =>
    Ledger.EventV1.parse({
      version: "ledger-event-v1",
      eventId: `${command.requestId}:${command.transitionId}:${index + 1}`,
      eventType,
      eventVersion: 1,
      owner,
      payload: projectNativeEventPayload(command, eventType),
      provenance: {
        version: "native-event-provenance-v1",
        principalId,
        requestId: command.requestId,
      },
    }),
  );
  return {
    command,
    eventTypes,
    append: Ledger.AppendBatchRequestV1.parse({
      version: "ledger-append-batch-request-v1",
      requestId: command.requestId,
      requestHash: command.requestHash,
      principalId,
      expectedHead: command.expectedHead,
      batch: {
        version: "ledger-batch-v1",
        batchId: `${command.requestId}:${command.transitionId}`,
        owner,
        events,
      },
    }),
  };
}

const MESSAGING_ID = /^(?:SS-0[1-5]|SF-0[1-3]|MS-0[1-7])$/;
const WORK_ATTEMPT_COMPLETION_ID = /^(?:WI-(?:0[1-9]|1[0-7])|AT-(?:0[1-9]|1[0-5])|CP-0[1-4])$/;
const WAIT_ID = /^WT-(?:0[1-9]|1[0-5])$/;
const GRANT_SCHEDULE_EFFECT_ID = /^(?:GR-0[1-4]|SC-0[1-2]|EF-0[1-4])$/;

export function prepareMessagingTransition(
  command: KernelTransitionCommandV1,
): PreparedKernelTransitionV1 {
  if (!MESSAGING_ID.test(command.transitionId)) {
    throw new UnknownKernelTransitionError(command.transitionId);
  }
  return prepareFamilyBatch(command);
}

export function prepareWorkAttemptCompletionTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): PreparedKernelTransitionV1 {
  if (!WORK_ATTEMPT_COMPLETION_ID.test(command.transitionId)) {
    throw new UnknownKernelTransitionError(command.transitionId);
  }
  const reason = workAttemptCompletionGuardReason(command, ownerEvents);
  if (reason !== null) throw new UnknownKernelTransitionError(`${command.transitionId}:${reason}`);
  return prepareFamilyBatch(command);
}

export function prepareWaitTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): PreparedKernelTransitionV1 {
  if (!WAIT_ID.test(command.transitionId))
    throw new UnknownKernelTransitionError(command.transitionId);
  const subjectEvents = ownerEvents.filter(
    ({ event }) => event.payload.subjectId === command.payload.subjectId,
  );
  const opened = subjectEvents.some(({ event }) => event.eventType === "wait.opened.v1");
  const resolved = subjectEvents.some(({ event }) => event.eventType === "wait.resolved.v1");
  const terminal = subjectEvents.some(({ event }) =>
    ["wait.resolved.v1", "wait.cancelled.v1", "wait.expired.v1"].includes(event.eventType),
  );
  const openOnly = new Set([
    "WT-02",
    "WT-03",
    "WT-05",
    "WT-06",
    "WT-08",
    "WT-09",
    "WT-10",
    "WT-12",
  ]);
  const resolvedOnly = new Set(["WT-07", "WT-13", "WT-14", "WT-15"]);
  if (command.transitionId === "WT-01" ? opened : !opened) {
    throw new UnknownKernelTransitionError(`${command.transitionId}:illegal_wait_existence_edge`);
  }
  if (openOnly.has(command.transitionId) && terminal) {
    throw new UnknownKernelTransitionError(`${command.transitionId}:wait_not_open`);
  }
  if (resolvedOnly.has(command.transitionId) && !resolved) {
    throw new UnknownKernelTransitionError(`${command.transitionId}:wait_not_resolved`);
  }
  if (command.transitionId === "WT-11" && !terminal) {
    throw new UnknownKernelTransitionError(`${command.transitionId}:wait_not_terminal`);
  }
  if (
    command.transitionId === "WT-04" &&
    !subjectEvents.some(({ event }) => event.eventType === "wait.response_recorded.v1")
  ) {
    throw new UnknownKernelTransitionError(`${command.transitionId}:duplicate_not_found`);
  }
  return prepareFamilyBatch(command);
}

export function prepareGrantScheduleEffectTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): PreparedKernelTransitionV1 {
  if (!GRANT_SCHEDULE_EFFECT_ID.test(command.transitionId)) {
    throw new UnknownKernelTransitionError(command.transitionId);
  }
  assertGrantScheduleEffectTransition(command, ownerEvents);
  return prepareFamilyBatch(command);
}
