import { z } from "zod";

const NonEmpty = z.string().min(1);
const Digest = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 digest");
const NativeEventTypesV1 = [
  "session.opened.v1",
  "session.metadata_revised.v1",
  "session.closed.v1",
  "session.expired.v1",
  "surface.bound.v1",
  "surface.rebound.v1",
  "surface.unbound.v1",
  "kernel.route.decided.v1",
  "message.inbound_recorded.v1",
  "message.assistant_started.v1",
  "message.part_appended.v1",
  "message.part_revised.v1",
  "message.status_changed.v1",
  "dispatch.decision.v1",
  "dispatch.pending.v1",
  "dispatch.received.v1",
  "dispatch.delivered.v1",
  "dispatch.failed.v1",
  "work.created.v1",
  "work.metadata_revised.v1",
  "work.criteria_revised.v1",
  "work.dependencies_replaced.v1",
  "work.started.v1",
  "work.evidence_recorded.v1",
  "work.readback_evidence_recorded.v1",
  "work.blocker_added.v1",
  "work.blocker_resolved.v1",
  "work.failed.v1",
  "work.cancelled.v1",
  "work.retry_exhausted.v1",
  "work.outcome_recorded.v1",
  "work.archived.v1",
  "work.assignment_changed.v1",
  "work.deadline_changed.v1",
  "work.completed.v1",
  "attempt.allocated.v1",
  "attempt.start_requested.v1",
  "attempt.running.v1",
  "attempt.start_failed.v1",
  "attempt.waiting.v1",
  "attempt.succeeded.v1",
  "attempt.failed.v1",
  "attempt.cancelled.v1",
  "attempt.interrupted.v1",
  "completion.candidate.submitted.v1",
  "completion.readback_requested.v1",
  "completion.claim_verdict_recorded.v1",
  "completion.candidate_rejected.v1",
  "completion.decision_recorded.v1",
  "wait.opened.v1",
  "wait.response_recorded.v1",
  "wait.resolved.v1",
  "wait.expired.v1",
  "wait.cancelled.v1",
  "wait.ambiguity_recorded.v1",
  "wait.ambiguity_selected.v1",
  "wait.follow_up_recorded.v1",
  "wait.reminder_requested.v1",
  "wait.resume_requested.v1",
  "wait.follow_up_window_closed.v1",
  "grant.created.v1",
  "grant.revoked.v1",
  "grant.expired.v1",
  "grant.revised.v1",
  "schedule.created.v1",
  "schedule.advanced.v1",
  "schedule.cancelled.v1",
  "schedule.fire_due.v1",
  "schedule.fire_settled.v1",
  "effect.intent.v1",
  "effect.confirmed.v1",
  "effect.definite_failed.v1",
  "effect.unknown.v1",
  "effect.manually_resolved.v1",
] as const;

const ConfigurationEventTypesV1 = [
  "artifact.referenced.v1",
  "actor.identity_registered.v1",
  "actor.identity_revised.v1",
  "actor.identity_retired.v1",
  "actor.endpoint_bound.v1",
  "actor.endpoint_rebound.v1",
  "actor.endpoint_unbound.v1",
  "authority.blacklist_created.v1",
  "authority.blacklist_revised.v1",
  "authority.blacklist_revoked.v1",
  "authority.blacklist_expired.v1",
  "authority.channel_grant_created.v1",
  "authority.channel_grant_revised.v1",
  "authority.channel_grant_revoked.v1",
  "connector.installation_registered.v1",
  "connector.definition_revised.v1",
  "connector.consent_requested.v1",
  "connector.consent_granted.v1",
  "connector.verification_requested.v1",
  "connector.verified.v1",
  "connector.verification_failed.v1",
  "connector.disabled.v1",
  "connector.uninstalled.v1",
] as const;

const ClosedEventTypesV1 = [...NativeEventTypesV1, ...ConfigurationEventTypesV1] as const;

export namespace Ledger {
  export const GENESIS_V1 = "GENESIS_V1" as const;
  export const OwnerV1 = z
    .object({
      version: z.literal("ledger-owner-v1"),
      ownerKey: NonEmpty,
    })
    .strict();
  export type OwnerV1 = z.infer<typeof OwnerV1>;

  export const HeadV1 = z
    .object({
      version: z.literal("ledger-head-v1"),
      owner: OwnerV1,
      ownerSeq: z.number().int().nonnegative(),
      eventHash: z.union([z.literal("GENESIS_V1"), Digest]),
    })
    .strict()
    .superRefine((head, ctx) => {
      if ((head.ownerSeq === 0) !== (head.eventHash === "GENESIS_V1")) {
        ctx.addIssue({ code: "custom", message: "only the genesis head may use GENESIS_V1" });
      }
    });
  export type HeadV1 = z.infer<typeof HeadV1>;

  export const NativeEventTypeV1 = z.enum(ClosedEventTypesV1);
  export type NativeEventTypeV1 = z.infer<typeof NativeEventTypeV1>;
  export const NativeEventProvenanceV1 = z
    .object({
      version: z.literal("native-event-provenance-v1"),
      principalId: NonEmpty,
      requestId: NonEmpty,
      sourceEventId: NonEmpty.optional(),
    })
    .strict();
  export type NativeEventProvenanceV1 = z.infer<typeof NativeEventProvenanceV1>;

  export const ContentBlobRefV1 = z
    .object({
      version: z.literal("content-blob-ref-v1"),
      digest: Digest,
      byteLength: z.number().int().nonnegative(),
      mediaType: NonEmpty,
    })
    .strict();

  const ModelRefV1 = z.object({ provider: NonEmpty, id: NonEmpty }).strict();
  const ProjectionEventBaseV1 = z
    .object({
      version: z.literal("native-event-payload-v1"),
      subjectId: NonEmpty,
      occurredAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  const eventFamilySchemas = {
    SS: ProjectionEventBaseV1.extend({
      sessionId: NonEmpty,
      parentSessionId: NonEmpty.nullable(),
      model: ModelRefV1,
      sessionSnapshotRef: ContentBlobRefV1,
    }).strict(),
    SF: ProjectionEventBaseV1.extend({
      sessionId: NonEmpty,
      surfaceId: NonEmpty,
      surfaceKind: NonEmpty,
      endpointId: NonEmpty,
      surfaceSnapshotRef: ContentBlobRefV1,
    }).strict(),
    MS: ProjectionEventBaseV1.extend({
      sessionId: NonEmpty,
      surfaceId: NonEmpty,
      messageId: NonEmpty,
      partId: NonEmpty.nullable(),
      role: z.enum(["user", "assistant", "system", "tool"]),
      status: NonEmpty,
      model: ModelRefV1.nullable(),
      messageSnapshotRef: ContentBlobRefV1,
      partSnapshotRef: ContentBlobRefV1.nullable(),
    }).strict(),
    RT: ProjectionEventBaseV1.extend({
      sessionId: NonEmpty,
      surfaceId: NonEmpty,
      messageId: NonEmpty,
      routeId: NonEmpty,
      routeDecision: NonEmpty,
      authoritySnapshotRef: ContentBlobRefV1,
      routeSnapshotRef: ContentBlobRefV1,
    }).strict(),
    DP: ProjectionEventBaseV1.extend({
      dispatchId: NonEmpty,
      routeId: NonEmpty,
      sourceSessionId: NonEmpty,
      sourceOwner: OwnerV1,
      destinationOwner: OwnerV1,
      dispatchDecision: NonEmpty,
      settlement: z.enum(["pending", "delivered", "definite_failed"]),
      dispatchSnapshotRef: ContentBlobRefV1,
      destinationReceiptRef: ContentBlobRefV1.nullable(),
      definiteFailureProofRef: ContentBlobRefV1.nullable(),
    }).strict(),
    WI: ProjectionEventBaseV1.extend({
      workItemId: NonEmpty,
      sessionId: NonEmpty,
      workSnapshotRef: ContentBlobRefV1,
    }).strict(),
    CP: ProjectionEventBaseV1.extend({
      workItemId: NonEmpty,
      candidateId: NonEmpty,
      runBindingRef: ContentBlobRefV1,
      completionSnapshotRef: ContentBlobRefV1,
      candidateArtifactRef: ContentBlobRefV1,
      verdictArtifactRef: ContentBlobRefV1.nullable(),
      admissionDecisionArtifactRef: ContentBlobRefV1.nullable(),
      verdictArtifactRefs: z.array(ContentBlobRefV1),
    }).strict(),
    AT: ProjectionEventBaseV1.extend({
      workItemId: NonEmpty,
      attemptId: NonEmpty,
      attemptSeq: z.number().int().positive(),
      sessionId: NonEmpty,
      runId: NonEmpty,
      model: ModelRefV1,
      environmentSnapshotRef: ContentBlobRefV1,
      attemptSnapshotRef: ContentBlobRefV1,
    }).strict(),
    WT: ProjectionEventBaseV1.extend({
      waitId: NonEmpty,
      waitEventVersion: NonEmpty,
      waitSnapshotRef: ContentBlobRefV1,
    }).strict(),
    GR: ProjectionEventBaseV1.extend({
      grantId: NonEmpty,
      workItemId: NonEmpty,
      attemptId: NonEmpty,
      granteeId: NonEmpty,
      grantScopeRef: ContentBlobRefV1,
      grantSnapshotRef: ContentBlobRefV1,
    }).strict(),
    SC: ProjectionEventBaseV1.extend({
      scheduleId: NonEmpty,
      generation: z.number().int().nonnegative(),
      nextFireRef: Digest.nullable(),
      settlementRef: Digest.nullable(),
      scheduleSnapshotRef: ContentBlobRefV1,
    }).strict(),
    EF: ProjectionEventBaseV1.extend({
      effectId: NonEmpty,
      idempotencyKey: NonEmpty,
      workItemId: NonEmpty,
      attemptId: NonEmpty,
      effectScopeRef: ContentBlobRefV1,
      settlement: z.enum([
        "pending",
        "confirmed",
        "definite_failed",
        "unknown",
        "manually_resolved",
      ]),
      effectSettlementRef: ContentBlobRefV1,
    }).strict(),
    CFG: ProjectionEventBaseV1.extend({ configurationSnapshotRef: ContentBlobRefV1 }).strict(),
  } as const;

  function eventFamily(
    eventType: (typeof ClosedEventTypesV1)[number],
  ): keyof typeof eventFamilySchemas {
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
    return "CFG";
  }

  const nativeEventPayloadSchemas = ClosedEventTypesV1.map((eventType) =>
    eventFamilySchemas[eventFamily(eventType)].extend({ eventType: z.literal(eventType) }).strict(),
  );
  /** Closed union: each event literal selects projection-sufficient facts with no generic append. */
  export interface NativeEventPayloadShapeV1 {
    readonly version: "native-event-payload-v1";
    readonly eventType: NativeEventTypeV1;
    readonly subjectId: string;
    readonly occurredAtDbMs: number;
    readonly sessionId?: string;
    readonly parentSessionId?: string | null;
    readonly model?: { readonly provider: string; readonly id: string } | null;
    readonly sessionSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly surfaceId?: string;
    readonly surfaceKind?: string;
    readonly endpointId?: string;
    readonly surfaceSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly messageId?: string;
    readonly partId?: string | null;
    readonly role?: "user" | "assistant" | "system" | "tool";
    readonly status?: string;
    readonly messageSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly partSnapshotRef?: z.infer<typeof ContentBlobRefV1> | null;
    readonly routeId?: string;
    readonly routeDecision?: string;
    readonly authoritySnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly routeSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly dispatchId?: string;
    readonly sourceSessionId?: string;
    readonly sourceOwner?: OwnerV1;
    readonly destinationOwner?: OwnerV1;
    readonly dispatchDecision?: string;
    readonly settlement?:
      | "pending"
      | "delivered"
      | "definite_failed"
      | "confirmed"
      | "unknown"
      | "manually_resolved";
    readonly dispatchSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly destinationReceiptRef?: z.infer<typeof ContentBlobRefV1> | null;
    readonly definiteFailureProofRef?: z.infer<typeof ContentBlobRefV1> | null;
    readonly workItemId?: string;
    readonly workSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly candidateId?: string;
    readonly runBindingRef?: z.infer<typeof ContentBlobRefV1>;
    readonly completionSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly candidateArtifactRef?: z.infer<typeof ContentBlobRefV1>;
    readonly verdictArtifactRef?: z.infer<typeof ContentBlobRefV1> | null;
    readonly admissionDecisionArtifactRef?: z.infer<typeof ContentBlobRefV1> | null;
    readonly verdictArtifactRefs?: readonly z.infer<typeof ContentBlobRefV1>[];
    readonly attemptId?: string;
    readonly attemptSeq?: number;
    readonly runId?: string;
    readonly environmentSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly attemptSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly waitId?: string;
    readonly waitEventVersion?: string;
    readonly waitSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly grantId?: string;
    readonly granteeId?: string;
    readonly grantScopeRef?: z.infer<typeof ContentBlobRefV1>;
    readonly grantSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly scheduleId?: string;
    readonly generation?: number;
    readonly nextFireRef?: string | null;
    readonly settlementRef?: string | z.infer<typeof ContentBlobRefV1> | null;
    readonly scheduleSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
    readonly effectId?: string;
    readonly idempotencyKey?: string;
    readonly effectScopeRef?: z.infer<typeof ContentBlobRefV1>;
    readonly effectSettlementRef?: z.infer<typeof ContentBlobRefV1>;
    readonly configurationSnapshotRef?: z.infer<typeof ContentBlobRefV1>;
  }

  export const NativeEventPayloadV1: z.ZodType<NativeEventPayloadShapeV1> = z.union(
    nativeEventPayloadSchemas as unknown as readonly [
      (typeof nativeEventPayloadSchemas)[number],
      (typeof nativeEventPayloadSchemas)[number],
      ...(typeof nativeEventPayloadSchemas)[number][],
    ],
  );
  export type NativeEventPayloadV1 = NativeEventPayloadShapeV1;
  export const NativeEventPayloadSchemasV1 = Object.freeze(
    Object.fromEntries(
      ClosedEventTypesV1.map((eventType, index) => [eventType, nativeEventPayloadSchemas[index]]),
    ),
  );

  export const EventV1 = z
    .object({
      version: z.literal("ledger-event-v1"),
      eventId: NonEmpty,
      eventType: NativeEventTypeV1,
      eventVersion: z.literal(1),
      owner: OwnerV1,
      payload: NativeEventPayloadV1,
      provenance: NativeEventProvenanceV1,
    })
    .strict()
    .superRefine((event, ctx) => {
      if (event.payload.eventType !== event.eventType) {
        ctx.addIssue({
          code: "custom",
          message: "event type and payload schema must match",
          path: ["payload", "eventType"],
        });
      }
    });
  export type EventV1 = z.infer<typeof EventV1>;

  export const BatchPositionV1 = z
    .object({
      version: z.literal("ledger-batch-position-v1"),
      batchId: NonEmpty,
      index: z.number().int().nonnegative(),
      size: z.number().int().min(1).max(64),
    })
    .strict()
    .refine((position) => position.index < position.size, {
      message: "batch index must be less than batch size",
      path: ["index"],
    });
  export type BatchPositionV1 = z.infer<typeof BatchPositionV1>;

  export const EnvelopeV1 = z
    .object({
      version: z.literal("ledger-envelope-v1"),
      envelopeVersion: z.literal(1),
      ledgerSeq: z.number().int().positive(),
      ownerSeq: z.number().int().positive(),
      previousEventHash: z.union([z.literal("GENESIS_V1"), Digest]),
      eventHash: Digest,
      event: EventV1,
      batch: BatchPositionV1,
      requestId: NonEmpty,
      requestHash: Digest,
      principalId: NonEmpty,
      committedAtDbMs: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((envelope, ctx) => {
      if ((envelope.ownerSeq === 1) !== (envelope.previousEventHash === "GENESIS_V1")) {
        ctx.addIssue({ code: "custom", message: "GENESIS_V1 must precede only owner sequence 1" });
      }
      if (envelope.requestId !== envelope.event.provenance.requestId) {
        ctx.addIssue({
          code: "custom",
          message: "envelope request ID must match event provenance",
          path: ["event", "provenance", "requestId"],
        });
      }
      if (envelope.principalId !== envelope.event.provenance.principalId) {
        ctx.addIssue({
          code: "custom",
          message: "envelope principal ID must match event provenance",
          path: ["event", "provenance", "principalId"],
        });
      }
    });
  export type EnvelopeV1 = z.infer<typeof EnvelopeV1>;

  export const BatchV1 = z
    .object({
      version: z.literal("ledger-batch-v1"),
      batchId: NonEmpty,
      owner: OwnerV1,
      events: z.array(EventV1).min(1).max(64),
    })
    .strict()
    .superRefine((batch, ctx) => {
      const eventIds = new Set<string>();
      for (const [index, event] of batch.events.entries()) {
        if (event.owner.ownerKey !== batch.owner.ownerKey) {
          ctx.addIssue({
            code: "custom",
            message: "a batch may contain events for exactly one owner",
            path: ["events", index, "owner", "ownerKey"],
          });
        }
        if (eventIds.has(event.eventId)) {
          ctx.addIssue({
            code: "custom",
            message: "event IDs must be unique within a batch",
            path: ["events", index, "eventId"],
          });
        }
        eventIds.add(event.eventId);
      }
    });
  export type BatchV1 = z.infer<typeof BatchV1>;

  export const AppendBatchRequestV1 = z
    .object({
      version: z.literal("ledger-append-batch-request-v1"),
      requestId: NonEmpty,
      requestHash: Digest,
      principalId: NonEmpty,
      expectedHead: HeadV1,
      batch: BatchV1,
    })
    .strict()
    .superRefine((request, ctx) => {
      if (request.expectedHead.owner.ownerKey !== request.batch.owner.ownerKey) {
        ctx.addIssue({
          code: "custom",
          message: "expected head and batch owner must match",
          path: ["batch", "owner"],
        });
      }
      for (const [index, event] of request.batch.events.entries()) {
        if (request.requestId !== event.provenance.requestId) {
          ctx.addIssue({
            code: "custom",
            message: "append request ID must match every event provenance",
            path: ["batch", "events", index, "provenance", "requestId"],
          });
        }
        if (request.principalId !== event.provenance.principalId) {
          ctx.addIssue({
            code: "custom",
            message: "append principal ID must match every event provenance",
            path: ["batch", "events", index, "provenance", "principalId"],
          });
        }
      }
    });
  export type AppendBatchRequestV1 = z.infer<typeof AppendBatchRequestV1>;

  export const AppendRequestV1 = z
    .object({
      version: z.literal("ledger-append-request-v1"),
      requestId: NonEmpty,
      requestHash: Digest,
      principalId: NonEmpty,
      expectedHead: HeadV1,
      event: EventV1,
    })
    .strict()
    .superRefine((request, ctx) => {
      if (request.expectedHead.owner.ownerKey !== request.event.owner.ownerKey) {
        ctx.addIssue({
          code: "custom",
          message: "expected head and event owner must match",
          path: ["event", "owner"],
        });
      }
      if (request.requestId !== request.event.provenance.requestId) {
        ctx.addIssue({
          code: "custom",
          message: "append request ID must match event provenance",
          path: ["event", "provenance", "requestId"],
        });
      }
      if (request.principalId !== request.event.provenance.principalId) {
        ctx.addIssue({
          code: "custom",
          message: "append principal ID must match event provenance",
          path: ["event", "provenance", "principalId"],
        });
      }
    });
  export type AppendRequestV1 = z.infer<typeof AppendRequestV1>;

  export const AppendReceiptV1 = z
    .object({
      version: z.literal("ledger-append-receipt-v1"),
      requestId: NonEmpty,
      requestHash: Digest,
      principalId: NonEmpty,
      owner: OwnerV1,
      previousHead: HeadV1,
      head: HeadV1,
      firstLedgerSeq: z.number().int().positive(),
      lastLedgerSeq: z.number().int().positive(),
      eventIds: z.array(NonEmpty).min(1).max(64),
      receiptHash: Digest,
    })
    .strict()
    .superRefine((receipt, ctx) => {
      const count = receipt.lastLedgerSeq - receipt.firstLedgerSeq + 1;
      if (count !== receipt.eventIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "receipt ledger range must cover every event",
          path: ["lastLedgerSeq"],
        });
      }
      if (
        receipt.owner.ownerKey !== receipt.previousHead.owner.ownerKey ||
        receipt.owner.ownerKey !== receipt.head.owner.ownerKey
      ) {
        ctx.addIssue({
          code: "custom",
          message: "receipt heads must have the receipt owner",
          path: ["owner"],
        });
      }
      if (receipt.head.ownerSeq - receipt.previousHead.ownerSeq !== receipt.eventIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "receipt owner sequence must advance once per event",
          path: ["head", "ownerSeq"],
        });
      }
      if (new Set(receipt.eventIds).size !== receipt.eventIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "receipt event IDs must be unique",
          path: ["eventIds"],
        });
      }
    });
  export type AppendReceiptV1 = z.infer<typeof AppendReceiptV1>;

  export const HeadConflictErrorV1 = z
    .object({
      version: z.literal("ledger-error-v1"),
      code: z.literal("head_conflict"),
      owner: OwnerV1,
      expectedHead: HeadV1,
      actualHead: HeadV1,
    })
    .strict()
    .superRefine((error, ctx) => {
      if (
        error.owner.ownerKey !== error.expectedHead.owner.ownerKey ||
        error.owner.ownerKey !== error.actualHead.owner.ownerKey
      ) {
        ctx.addIssue({
          code: "custom",
          message: "conflicting heads must have the reported owner",
          path: ["owner"],
        });
      }
      if (
        error.expectedHead.ownerSeq === error.actualHead.ownerSeq &&
        error.expectedHead.eventHash === error.actualHead.eventHash
      ) {
        ctx.addIssue({
          code: "custom",
          message: "a head conflict must report distinct expected and actual heads",
          path: ["actualHead"],
        });
      }
    });
  export type HeadConflictErrorV1 = z.infer<typeof HeadConflictErrorV1>;

  export const IdempotencyMismatchErrorV1 = z
    .object({
      version: z.literal("ledger-error-v1"),
      code: z.literal("idempotency_mismatch"),
      requestId: NonEmpty,
      expectedRequestHash: Digest,
      actualRequestHash: Digest,
      expectedPrincipalId: NonEmpty,
      actualPrincipalId: NonEmpty,
    })
    .strict()
    .refine(
      (error) =>
        error.expectedRequestHash !== error.actualRequestHash ||
        error.expectedPrincipalId !== error.actualPrincipalId,
      {
        message: "an idempotency mismatch must report different request facts",
      },
    );
  export type IdempotencyMismatchErrorV1 = z.infer<typeof IdempotencyMismatchErrorV1>;

  export const LedgerCASErrorV1 = z.union([HeadConflictErrorV1, IdempotencyMismatchErrorV1]);
  export type LedgerCASErrorV1 = z.infer<typeof LedgerCASErrorV1>;

  export const WorkItemRefV1 = z
    .object({ version: z.literal("work-item-ref-v1"), workItemId: NonEmpty })
    .strict();
  export type WorkItemRefV1 = z.infer<typeof WorkItemRefV1>;

  export const AttemptRefV1 = z
    .object({
      version: z.literal("attempt-ref-v1"),
      workItemId: NonEmpty,
      attemptId: NonEmpty,
      attemptSeq: z.number().int().positive(),
    })
    .strict();
  export type AttemptRefV1 = z.infer<typeof AttemptRefV1>;

  export const EffectRefV1 = z
    .object({ version: z.literal("effect-ref-v1"), effectId: NonEmpty, idempotencyKey: NonEmpty })
    .strict();
  export type EffectRefV1 = z.infer<typeof EffectRefV1>;

  export const VerifierVerdictV1 = z.enum(["verified", "refuted", "asserted", "pending"]);
  export type VerifierVerdictV1 = z.infer<typeof VerifierVerdictV1>;

  export const VerifierRefV1 = z
    .object({
      version: z.literal("verifier-ref-v1"),
      verifierId: NonEmpty,
      verifierVersion: NonEmpty,
      family: z.enum([
        "executable_recheck",
        "citation_quote_match",
        "frozen_nli_support",
        "constrained_decoding_validity",
      ]),
      checkedPredicate: NonEmpty,
      verdict: VerifierVerdictV1,
    })
    .strict();
  export type VerifierRefV1 = z.infer<typeof VerifierRefV1>;

  export const StakesRefV1 = z
    .object({
      version: z.literal("stakes-ref-v1"),
      stakesVersion: z.literal("stakes-v1"),
      asOfLedgerSeq: z.number().int().nonnegative(),
      asOfDbMs: z.number().int().nonnegative(),
      value: z.number().int().nonnegative(),
      threshold: z.number().int().positive(),
    })
    .strict();
  export type StakesRefV1 = z.infer<typeof StakesRefV1>;

  export const ReplayRefV1 = z
    .object({
      version: z.literal("replay-ref-v1"),
      replayKey: Digest,
      firstLedgerSeq: z.number().int().positive(),
      lastLedgerSeq: z.number().int().positive(),
      environmentFingerprint: Digest,
      schemaVersion: z.literal("ledger-native-schema-r9-v1"),
      nondeterminismManifestHash: Digest,
    })
    .strict()
    .refine((ref) => ref.firstLedgerSeq <= ref.lastLedgerSeq, {
      message: "replay ledger range must be ordered",
      path: ["lastLedgerSeq"],
    });
  export type ReplayRefV1 = z.infer<typeof ReplayRefV1>;

  export const Event = EventV1;
  export type Event = EventV1;
  export const OwnerRef = OwnerV1;
  export type OwnerRef = OwnerV1;
  export const Head = HeadV1;
  export type Head = HeadV1;
  export const AppendBatch = AppendBatchRequestV1;
  export type AppendBatch = AppendBatchRequestV1;
  export const AppendResult = AppendReceiptV1;
  export type AppendResult = AppendReceiptV1;
  export const AppendError = LedgerCASErrorV1;
  export type AppendError = LedgerCASErrorV1;
}
