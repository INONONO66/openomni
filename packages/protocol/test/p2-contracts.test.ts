import { describe, expect, test } from "bun:test";
import { Execution, Ledger, Wait } from "../src/index.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const owner = { version: "ledger-owner-v1" as const, ownerKey: "work:w1" };
const eventBlob = {
  version: "content-blob-ref-v1" as const,
  digest,
  byteLength: 1,
  mediaType: "application/json",
};
const event = {
  version: "ledger-event-v1" as const,
  eventId: "event-1",
  eventType: "work.created.v1",
  eventVersion: 1 as const,
  owner,
  payload: {
    version: "native-event-payload-v1" as const,
    eventType: "work.created.v1" as const,
    subjectId: "w1",
    occurredAtDbMs: 10,
    workItemId: "w1",
    sessionId: "session-1",
    workSnapshotRef: eventBlob,
  },
  provenance: {
    version: "native-event-provenance-v1" as const,
    principalId: "resident-1",
    requestId: "request-1",
  },
};
const genesis = {
  version: "ledger-head-v1" as const,
  owner,
  ownerSeq: 0,
  eventHash: "GENESIS_V1" as const,
};

const workspace = {
  canonicalizerVersion: "workspace-v1" as const,
  workspaceId: `w1:${digest}`,
  canonicalBytesDigest: digest,
};

const attempt = {
  version: "attempt-ref-v1" as const,
  workItemId: "w1",
  attemptId: "attempt-1",
  attemptSeq: 1,
};

const credential = {
  version: "credential-source-ref-v1" as const,
  providerId: "openai",
  authType: "api" as const,
  credentialId: "owner-openai",
  rotationId: "r1",
  sourceKind: "default_file" as const,
  sourcePathDigest: digest,
  credentialDigest: otherDigest,
};

describe("P2 dormant Ledger contracts", () => {
  test("parses versioned event, single append, batch, envelope, and receipt fixtures", () => {
    expect(Ledger.EventV1.parse(event).eventId).toBe("event-1");
    expect(
      Ledger.AppendRequestV1.parse({
        version: "ledger-append-request-v1",
        requestId: "request-1",
        requestHash: digest,
        principalId: "resident-1",
        expectedHead: genesis,
        event,
      }).event.owner.ownerKey,
    ).toBe(owner.ownerKey);

    expect(
      Ledger.AppendBatchRequestV1.parse({
        version: "ledger-append-batch-request-v1",
        requestId: "request-1",
        requestHash: digest,
        principalId: "resident-1",
        expectedHead: genesis,
        batch: { version: "ledger-batch-v1", batchId: "batch-1", owner, events: [event] },
      }).batch.events,
    ).toHaveLength(1);

    expect(
      Ledger.EnvelopeV1.parse({
        version: "ledger-envelope-v1",
        envelopeVersion: 1,
        ledgerSeq: 7,
        ownerSeq: 1,
        previousEventHash: "GENESIS_V1",
        eventHash: digest,
        event,
        batch: { version: "ledger-batch-position-v1", batchId: "batch-1", index: 0, size: 1 },
        requestId: "request-1",
        requestHash: digest,
        principalId: "resident-1",
        committedAtDbMs: 10,
      }).ledgerSeq,
    ).toBe(7);

    expect(
      Ledger.AppendReceiptV1.parse({
        version: "ledger-append-receipt-v1",
        requestId: "request-1",
        requestHash: digest,
        principalId: "resident-1",
        owner,
        previousHead: genesis,
        head: { version: "ledger-head-v1", owner, ownerSeq: 1, eventHash: digest },
        firstLedgerSeq: 7,
        lastLedgerSeq: 7,
        eventIds: ["event-1"],
        receiptHash: otherDigest,
      }).head.ownerSeq,
    ).toBe(1);
  });

  test("rejects isolated top-level attribution mismatches", () => {
    const append = {
      version: "ledger-append-request-v1" as const,
      requestId: event.provenance.requestId,
      requestHash: digest,
      principalId: event.provenance.principalId,
      expectedHead: genesis,
      event,
    };
    expect(Ledger.AppendRequestV1.parse(append).requestId).toBe(event.provenance.requestId);
    expect(() =>
      Ledger.AppendRequestV1.parse({ ...append, requestId: "request-forged" }),
    ).toThrow();
    expect(() =>
      Ledger.AppendRequestV1.parse({ ...append, principalId: "principal-forged" }),
    ).toThrow();

    const secondEvent = { ...event, eventId: "event-2" };
    const appendBatch = {
      version: "ledger-append-batch-request-v1" as const,
      requestId: event.provenance.requestId,
      requestHash: digest,
      principalId: event.provenance.principalId,
      expectedHead: genesis,
      batch: {
        version: "ledger-batch-v1" as const,
        batchId: "batch-1",
        owner,
        events: [event, secondEvent],
      },
    };
    expect(Ledger.AppendBatchRequestV1.parse(appendBatch).batch.events).toHaveLength(2);
    expect(() =>
      Ledger.AppendBatchRequestV1.parse({ ...appendBatch, requestId: "request-forged" }),
    ).toThrow();
    expect(() =>
      Ledger.AppendBatchRequestV1.parse({ ...appendBatch, principalId: "principal-forged" }),
    ).toThrow();
    expect(() =>
      Ledger.AppendBatchRequestV1.parse({
        ...appendBatch,
        batch: {
          ...appendBatch.batch,
          events: [
            event,
            {
              ...secondEvent,
              provenance: { ...secondEvent.provenance, requestId: "request-other" },
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      Ledger.AppendBatchRequestV1.parse({
        ...appendBatch,
        batch: {
          ...appendBatch.batch,
          events: [
            event,
            {
              ...secondEvent,
              provenance: { ...secondEvent.provenance, principalId: "principal-other" },
            },
          ],
        },
      }),
    ).toThrow();

    const envelope = {
      version: "ledger-envelope-v1" as const,
      envelopeVersion: 1 as const,
      ledgerSeq: 7,
      ownerSeq: 1,
      previousEventHash: "GENESIS_V1" as const,
      eventHash: digest,
      event,
      batch: {
        version: "ledger-batch-position-v1" as const,
        batchId: "batch-1",
        index: 0,
        size: 1,
      },
      requestId: event.provenance.requestId,
      requestHash: digest,
      principalId: event.provenance.principalId,
      committedAtDbMs: 10,
    };
    expect(Ledger.EnvelopeV1.parse(envelope).requestId).toBe(event.provenance.requestId);
    expect(() => Ledger.EnvelopeV1.parse({ ...envelope, requestId: "request-forged" })).toThrow();
    expect(() =>
      Ledger.EnvelopeV1.parse({ ...envelope, principalId: "principal-forged" }),
    ).toThrow();
  });

  test("rejects mixed schema versions, multiple owners, duplicate events, empty batches, and invalid batch positions", () => {
    expect(() =>
      Ledger.EventV1.parse({ ...event, owner: { ...owner, version: "ledger-owner-v2" } }),
    ).toThrow();
    expect(() =>
      Ledger.EventV1.parse({
        ...event,
        payload: { ...event.payload, arbitraryCredential: "raw-secret" },
      }),
    ).toThrow();
    expect(() =>
      Ledger.BatchV1.parse({
        version: "ledger-batch-v1",
        batchId: "batch-1",
        owner,
        events: [event, { ...event, eventId: "event-2", owner: { ...owner, ownerKey: "work:w2" } }],
      }),
    ).toThrow();
    expect(() =>
      Ledger.BatchV1.parse({
        version: "ledger-batch-v1",
        batchId: "batch-1",
        owner,
        events: [event, event],
      }),
    ).toThrow();
    expect(() =>
      Ledger.BatchV1.parse({ version: "ledger-batch-v1", batchId: "batch-1", owner, events: [] }),
    ).toThrow();
    expect(() =>
      Ledger.BatchPositionV1.parse({
        version: "ledger-batch-position-v1",
        batchId: "batch-1",
        index: 1,
        size: 1,
      }),
    ).toThrow();
  });

  test("rejects Ledger head, envelope, append, receipt, conflict, and replay invariants", () => {
    const nextHead = { version: "ledger-head-v1" as const, owner, ownerSeq: 1, eventHash: digest };
    const otherOwner = { ...owner, ownerKey: "work:w2" };
    expect(() => Ledger.HeadV1.parse({ ...genesis, eventHash: digest })).toThrow();
    expect(() => Ledger.HeadV1.parse({ ...nextHead, eventHash: "GENESIS_V1" })).toThrow();

    const envelope = {
      version: "ledger-envelope-v1",
      envelopeVersion: 1,
      ledgerSeq: 7,
      ownerSeq: 1,
      previousEventHash: "GENESIS_V1",
      eventHash: digest,
      event,
      batch: { version: "ledger-batch-position-v1", batchId: "batch-1", index: 0, size: 1 },
      requestId: "request-1",
      requestHash: digest,
      principalId: "resident-1",
      committedAtDbMs: 10,
    };
    expect(() =>
      Ledger.EnvelopeV1.parse({ ...envelope, previousEventHash: otherDigest }),
    ).toThrow();
    expect(() =>
      Ledger.EnvelopeV1.parse({ ...envelope, ownerSeq: 2, previousEventHash: "GENESIS_V1" }),
    ).toThrow();

    expect(() =>
      Ledger.AppendRequestV1.parse({
        version: "ledger-append-request-v1",
        requestId: "request-1",
        requestHash: digest,
        principalId: "resident-1",
        expectedHead: genesis,
        event: { ...event, owner: otherOwner },
      }),
    ).toThrow();
    expect(() =>
      Ledger.AppendBatchRequestV1.parse({
        version: "ledger-append-batch-request-v1",
        requestId: "request-1",
        requestHash: digest,
        principalId: "resident-1",
        expectedHead: genesis,
        batch: {
          version: "ledger-batch-v1",
          batchId: "batch-1",
          owner: otherOwner,
          events: [{ ...event, owner: otherOwner }],
        },
      }),
    ).toThrow();

    const receipt = {
      version: "ledger-append-receipt-v1",
      requestId: "request-1",
      requestHash: digest,
      principalId: "resident-1",
      owner,
      previousHead: genesis,
      head: nextHead,
      firstLedgerSeq: 7,
      lastLedgerSeq: 7,
      eventIds: ["event-1"],
      receiptHash: otherDigest,
    };
    expect(() => Ledger.AppendReceiptV1.parse({ ...receipt, lastLedgerSeq: 8 })).toThrow();
    expect(() =>
      Ledger.AppendReceiptV1.parse({ ...receipt, previousHead: { ...genesis, owner: otherOwner } }),
    ).toThrow();
    expect(() =>
      Ledger.AppendReceiptV1.parse({ ...receipt, head: { ...nextHead, owner: otherOwner } }),
    ).toThrow();
    expect(() =>
      Ledger.AppendReceiptV1.parse({ ...receipt, head: { ...nextHead, ownerSeq: 2 } }),
    ).toThrow();
    expect(() =>
      Ledger.AppendReceiptV1.parse({
        ...receipt,
        head: { ...nextHead, ownerSeq: 2 },
        lastLedgerSeq: 8,
        eventIds: ["event-1", "event-1"],
      }),
    ).toThrow();

    expect(() =>
      Ledger.HeadConflictErrorV1.parse({
        version: "ledger-error-v1",
        code: "head_conflict",
        owner,
        expectedHead: { ...genesis, owner: otherOwner },
        actualHead: nextHead,
      }),
    ).toThrow();
    expect(() =>
      Ledger.HeadConflictErrorV1.parse({
        version: "ledger-error-v1",
        code: "head_conflict",
        owner,
        expectedHead: genesis,
        actualHead: { ...nextHead, owner: otherOwner },
      }),
    ).toThrow();
    expect(() =>
      Ledger.HeadConflictErrorV1.parse({
        version: "ledger-error-v1",
        code: "head_conflict",
        owner,
        expectedHead: genesis,
        actualHead: genesis,
      }),
    ).toThrow();
    expect(() =>
      Ledger.ReplayRefV1.parse({
        version: "replay-ref-v1",
        replayKey: digest,
        firstLedgerSeq: 2,
        lastLedgerSeq: 1,
        environmentFingerprint: digest,
        schemaVersion: "ledger-native-schema-r9-v1",
        nondeterminismManifestHash: otherDigest,
      }),
    ).toThrow();
    expect(() =>
      Ledger.IdempotencyMismatchErrorV1.parse({
        version: "ledger-error-v1",
        code: "idempotency_mismatch",
        requestId: "request-1",
        expectedRequestHash: digest,
        actualRequestHash: digest,
        expectedPrincipalId: "resident-1",
        actualPrincipalId: "resident-1",
      }),
    ).toThrow();
  });

  test("rejects unknown event types, payload mismatches, and removed replay fields", () => {
    expect(() => Ledger.EventV1.parse({ ...event, eventType: "work.unknown.v1" })).toThrow();
    expect(() => Ledger.EventV1.parse({ ...event, eventType: "work.failed.v1" })).toThrow();
    expect(() =>
      Ledger.ReplayRefV1.parse({
        version: "replay-ref-v1",
        replayKey: digest,
        firstLedgerSeq: 1,
        lastLedgerSeq: 1,
        environmentFingerprint: digest,
        schemaVersion: "ledger-native-schema-r9-v1",
        upcastVersion: "legacy-v1",
        nondeterminismManifestHash: otherDigest,
      }),
    ).toThrow();
  });

  test("parses typed CAS errors and consumer references", () => {
    expect(
      Ledger.LedgerCASErrorV1.parse({
        version: "ledger-error-v1",
        code: "head_conflict",
        owner,
        expectedHead: genesis,
        actualHead: { version: "ledger-head-v1", owner, ownerSeq: 1, eventHash: digest },
      }).code,
    ).toBe("head_conflict");
    expect(
      Ledger.VerifierRefV1.parse({
        version: "verifier-ref-v1",
        verifierId: "citation",
        verifierVersion: "1",
        family: "citation_quote_match",
        checkedPredicate: "source contains quoted text",
        verdict: "refuted",
      }).verdict,
    ).toBe("refuted");
    expect(
      Ledger.StakesRefV1.parse({
        version: "stakes-ref-v1",
        stakesVersion: "stakes-v1",
        asOfLedgerSeq: 10,
        asOfDbMs: 20,
        value: 1000,
        threshold: 1000,
      }).value,
    ).toBe(1000);
  });
});

describe("P2 dormant Wait contracts", () => {
  const opened = {
    version: "wait.opened.v1" as const,
    waitId: "wait-1",
    ownerRef: { version: "wait-owner-ref-v1" as const, kind: "workItem" as const, id: "w1" },
    expectedResponders: [
      { version: "wait-responder-ref-v1" as const, actorId: "owner" },
      { version: "wait-responder-ref-v1" as const, actorId: "reviewer" },
    ],
    correlation: { version: "wait-correlation-v1" as const, threadId: "thread-1" },
    allowedActions: ["report_result" as const],
    resolutionPolicy: "n-of-m-v1",
    quorum: { version: "wait-quorum-v1" as const, required: 1, total: 2 },
    status: "open" as const,
    deadline: 100,
    partial: false as const,
    followUpWindow: 50,
    attempt,
  };

  test("parses open, response, resolution, expiry, and cancellation fixtures", () => {
    expect(Wait.OpenedV1.parse(opened).status).toBe("open");
    expect(
      Wait.ResponseRecordedV1.parse({
        version: "wait.response_recorded.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        responder: opened.expectedResponders[0],
        transportId: "message-1",
        responseHash: digest,
        action: "report_result",
        payloadRef: "message:1",
        recordedAtDbMs: 40,
      }).transportId,
    ).toBe("message-1");
    expect(
      Wait.ResolvedV1.parse({
        version: "wait.resolved.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        responseEventIds: ["response-1"],
        quorum: opened.quorum,
        partial: false,
        resolvedAtDbMs: 50,
      }).partial,
    ).toBe(false);
    expect(
      Wait.ExpiredV1.parse({
        version: "wait.expired.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        expiredAtDbMs: 101,
        responseEventIds: [],
        partial: true,
      }).partial,
    ).toBe(true);
    expect(
      Wait.CancelledV1.parse({
        version: "wait.cancelled.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        cancelledAtDbMs: 60,
        reason: "owner cancelled",
      }).reason,
    ).toBe("owner cancelled");
  });

  test("binds work-item wait owners to attempt work items", () => {
    expect(Wait.OpenedV1.parse(opened).attempt?.workItemId).toBe(opened.ownerRef.id);
    expect(() =>
      Wait.OpenedV1.parse({ ...opened, attempt: { ...attempt, workItemId: "w2" } }),
    ).toThrow();

    const resume = {
      version: "wait.resume_requested.v1" as const,
      waitId: opened.waitId,
      ownerRef: opened.ownerRef,
      attempt,
      responseEventIds: ["response-1"],
      requestedAtDbMs: 60,
    };
    expect(Wait.ResumeRequestedV1.parse(resume).attempt.workItemId).toBe(opened.ownerRef.id);
    expect(() =>
      Wait.ResumeRequestedV1.parse({ ...resume, attempt: { ...attempt, workItemId: "w2" } }),
    ).toThrow();

    const sessionOwner = {
      version: "wait-owner-ref-v1" as const,
      kind: "session" as const,
      id: "session-1",
    };
    expect(Wait.OpenedV1.parse({ ...opened, ownerRef: sessionOwner }).ownerRef).toEqual(
      sessionOwner,
    );
    expect(Wait.ResumeRequestedV1.parse({ ...resume, ownerRef: sessionOwner }).ownerRef).toEqual(
      sessionOwner,
    );
  });

  test("rejects missing variant-specific fields in every base lifecycle event", () => {
    expect(() =>
      Wait.LifecycleEventV1.parse({ ...opened, expectedResponders: undefined }),
    ).toThrow();
    expect(() =>
      Wait.LifecycleEventV1.parse({
        version: "wait.response_recorded.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        responder: opened.expectedResponders[0],
        transportId: "message-1",
        responseHash: digest,
        payloadRef: "message:1",
        recordedAtDbMs: 40,
      }),
    ).toThrow();
    expect(() =>
      Wait.LifecycleEventV1.parse({
        version: "wait.resolved.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        responseEventIds: ["response-1"],
        partial: false,
        resolvedAtDbMs: 50,
      }),
    ).toThrow();
    expect(() =>
      Wait.LifecycleEventV1.parse({
        version: "wait.expired.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        responseEventIds: [],
        partial: true,
      }),
    ).toThrow();
    expect(() =>
      Wait.LifecycleEventV1.parse({
        version: "wait.cancelled.v1",
        waitId: "wait-1",
        ownerRef: opened.ownerRef,
        cancelledAtDbMs: 60,
      }),
    ).toThrow();
  });

  test("rejects invalid quorum, duplicate responders, and empty correlation", () => {
    expect(() =>
      Wait.OpenedV1.parse({ ...opened, quorum: { ...opened.quorum, required: 3 } }),
    ).toThrow();
    expect(() =>
      Wait.OpenedV1.parse({
        ...opened,
        expectedResponders: [opened.expectedResponders[0], opened.expectedResponders[0]],
      }),
    ).toThrow();
    expect(() =>
      Wait.OpenedV1.parse({ ...opened, correlation: { version: "wait-correlation-v1" } }),
    ).toThrow();
  });

  test("requires lowercase SHA-256 correlation token digests", () => {
    const tokenCorrelation = {
      version: "wait-correlation-v1" as const,
      tokenHash: digest,
    };
    expect(Wait.CorrelationV1.parse(tokenCorrelation).tokenHash).toBe(digest);
    for (const tokenHash of ["not-a-digest", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      expect(() => Wait.CorrelationV1.parse({ ...tokenCorrelation, tokenHash })).toThrow();
    }
  });

  test("parses every extended lifecycle event and rejects incomplete variants", () => {
    const common = { waitId: "wait-1", ownerRef: opened.ownerRef };
    const variants = [
      {
        version: "wait.ambiguity_recorded.v1",
        ...common,
        candidateWaitIds: ["wait-1", "wait-2"],
        transportId: "m1",
        responseHash: digest,
        recordedAtDbMs: 10,
      },
      {
        version: "wait.ambiguity_selected.v1",
        ...common,
        ambiguityEventId: "a1",
        selectedWaitId: "wait-1",
        selectedAtDbMs: 11,
      },
      {
        version: "wait.response_selected.v1",
        ...common,
        responseEventId: "r1",
        selectedByPrincipalId: "owner",
        selectedAtDbMs: 12,
      },
      {
        version: "wait.follow_up_recorded.v1",
        ...common,
        responder: opened.expectedResponders[0],
        transportId: "m2",
        responseHash: digest,
        payloadRef: "message:2",
        recordedAtDbMs: 13,
      },
      {
        version: "wait.reminder_requested.v1",
        ...common,
        responder: opened.expectedResponders[0],
        reminderOrdinal: 1,
        requestedAtDbMs: 14,
      },
      {
        version: "wait.resume_requested.v1",
        ...common,
        attempt,
        responseEventIds: ["r1"],
        requestedAtDbMs: 15,
      },
      {
        version: "wait.follow_up_window_closed.v1",
        ...common,
        followUpEventIds: [],
        closedAtDbMs: 16,
      },
      {
        version: "wait.partial_deadline.v1",
        ...common,
        responseEventIds: ["r1"],
        quorum: { ...opened.quorum, required: 2 },
        observedAtDbMs: 17,
      },
      {
        version: "wait.late_rejected.v1",
        ...common,
        transportId: "m3",
        responseHash: digest,
        terminalEventId: "resolved-1",
        rejectedAtDbMs: 18,
      },
    ];
    for (const variant of variants)
      expect(Wait.LifecycleEventV1.parse(variant).waitId).toBe("wait-1");
    const requiredVariantFields = [
      "candidateWaitIds",
      "ambiguityEventId",
      "responseEventId",
      "payloadRef",
      "reminderOrdinal",
      "attempt",
      "followUpEventIds",
      "quorum",
      "terminalEventId",
    ];
    for (const [index, variant] of variants.entries()) {
      const requiredField = requiredVariantFields[index];
      const incomplete = Object.fromEntries(
        Object.entries(variant).filter(([field]) => field !== requiredField),
      );
      expect(() => Wait.LifecycleEventV1.parse(incomplete)).toThrow();
    }
  });

  test("rejects every Wait reference uniqueness and quorum refinement branch", () => {
    const common = { waitId: "wait-1", ownerRef: opened.ownerRef };
    expect(() =>
      Wait.OpenedV1.parse({ ...opened, quorum: { ...opened.quorum, total: 1 } }),
    ).toThrow();
    expect(() =>
      Wait.OpenedV1.parse({
        ...opened,
        allowedActions: ["report_result", "report_result"],
      }),
    ).toThrow();
    expect(() =>
      Wait.ResolvedV1.parse({
        version: "wait.resolved.v1",
        ...common,
        responseEventIds: ["r1", "r1"],
        quorum: { ...opened.quorum, required: 2 },
        partial: false,
        resolvedAtDbMs: 20,
      }),
    ).toThrow();
    expect(() =>
      Wait.ResolvedV1.parse({
        version: "wait.resolved.v1",
        ...common,
        responseEventIds: ["r1"],
        quorum: { ...opened.quorum, required: 2 },
        partial: false,
        resolvedAtDbMs: 20,
      }),
    ).toThrow();
    expect(() =>
      Wait.ResolvedV1.parse({
        version: "wait.resolved.v1",
        ...common,
        responseEventIds: ["r1", "r2"],
        quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
        partial: true,
        resolvedAtDbMs: 20,
      }),
    ).toThrow();
    const partialResolution = {
      version: "wait.resolved.v1" as const,
      ...common,
      quorum: { version: "wait-quorum-v1" as const, required: 2, total: 3 },
      partial: true,
      resolvedAtDbMs: 20,
    };
    expect(
      Wait.ResolvedV1.parse({ ...partialResolution, responseEventIds: ["r1"] }).responseEventIds,
    ).toEqual(["r1"]);
    expect(() =>
      Wait.ResolvedV1.parse({ ...partialResolution, responseEventIds: ["r1", "r2"] }),
    ).toThrow();
    expect(() =>
      Wait.ResolvedV1.parse({
        ...partialResolution,
        responseEventIds: ["r1", "r2", "r3"],
      }),
    ).toThrow();
    const thresholdResolution = { ...partialResolution, partial: false };
    expect(
      Wait.ResolvedV1.parse({ ...thresholdResolution, responseEventIds: ["r1", "r2"] })
        .responseEventIds,
    ).toHaveLength(2);
    expect(
      Wait.ResolvedV1.parse({
        ...thresholdResolution,
        responseEventIds: ["r1", "r2", "r3"],
      }).responseEventIds,
    ).toHaveLength(3);
    expect(() =>
      Wait.AmbiguityRecordedV1.parse({
        version: "wait.ambiguity_recorded.v1",
        ...common,
        candidateWaitIds: ["wait-1", "wait-1"],
        transportId: "m1",
        responseHash: digest,
        recordedAtDbMs: 20,
      }),
    ).toThrow();
    expect(() =>
      Wait.ExpiredV1.parse({
        version: "wait.expired.v1",
        ...common,
        expiredAtDbMs: 20,
        responseEventIds: ["r1", "r1"],
        partial: true,
      }),
    ).toThrow();
    expect(() =>
      Wait.ResumeRequestedV1.parse({
        version: "wait.resume_requested.v1",
        ...common,
        attempt,
        responseEventIds: ["r1", "r1"],
        requestedAtDbMs: 20,
      }),
    ).toThrow();
    expect(() =>
      Wait.FollowUpWindowClosedV1.parse({
        version: "wait.follow_up_window_closed.v1",
        ...common,
        followUpEventIds: ["f1", "f1"],
        closedAtDbMs: 20,
      }),
    ).toThrow();
    expect(() =>
      Wait.PartialDeadlineV1.parse({
        version: "wait.partial_deadline.v1",
        ...common,
        responseEventIds: ["r1", "r1"],
        quorum: { version: "wait-quorum-v1", required: 3, total: 3 },
        observedAtDbMs: 20,
      }),
    ).toThrow();
    expect(() =>
      Wait.PartialDeadlineV1.parse({
        version: "wait.partial_deadline.v1",
        ...common,
        responseEventIds: ["r1", "r2"],
        quorum: { version: "wait-quorum-v1", required: 2, total: 2 },
        observedAtDbMs: 20,
      }),
    ).toThrow();
  });
});

describe("P2 dormant workspace, effect, and credential contracts", () => {
  test("parses closed workspace/effect scope and LLM environment refs", () => {
    expect(Execution.WorkspaceRefV1.parse(workspace).workspaceId).toBe(`w1:${digest}`);
    expect(
      Execution.EffectScopeV1.parse({
        version: "effect-scope-v1",
        workspace,
        resources: [
          { version: "resource-scope-v1", kind: "endpoint", targetDigest: digest },
          { version: "resource-scope-v1", kind: "workspace", target: "**" },
        ],
        resolver: { id: "bash-workspace-v1", version: "1", inputDigest: digest },
        containment: "none",
        mutationClass: "unknown",
      }).mutationClass,
    ).toBe("unknown");
    expect(
      Execution.LLMEnvironmentV1.parse({
        version: "llm-environment-v1",
        catalogSchemaVersion: 1,
        catalogSource: "bundled",
        catalogSourceVersion: "2026-07-25",
        catalogDigest: digest,
        modelDigest: otherDigest,
        endpoint: {
          version: "llm-endpoint-ref-v1",
          kind: "default",
          valueRef: "provider-default",
          endpointDigest: digest,
        },
        credential,
        sdkPackage: "@ai-sdk/openai",
        adapterVersion: "1",
        environmentDigest: digest,
      }).credential.rotationId,
    ).toBe("r1");
  });

  test("rejects malformed scopes, unsorted/duplicate resources, raw credentials, and unsupported versions", () => {
    expect(() =>
      Execution.WorkspaceRefV1.parse({ ...workspace, workspaceId: "relative/path" }),
    ).toThrow();
    const resource = { version: "resource-scope-v1", kind: "workspace", target: "**" };
    expect(() =>
      Execution.EffectScopeV1.parse({
        version: "effect-scope-v1",
        workspace,
        resources: [resource, resource],
        resolver: { id: "bash-workspace-v1", version: "1", inputDigest: digest },
        containment: "none",
        mutationClass: "unknown",
      }),
    ).toThrow();
    expect(() =>
      Execution.EffectScopeV1.parse({
        version: "effect-scope-v1",
        workspace,
        resources: [
          { version: "resource-scope-v1", kind: "workspace", target: "**" },
          { version: "resource-scope-v1", kind: "endpoint", targetDigest: digest },
        ],
        resolver: { id: "bash-workspace-v1", version: "1", inputDigest: digest },
        containment: "none",
        mutationClass: "unknown",
      }),
    ).toThrow();
    expect(() =>
      Execution.CredentialSourceRefV1.parse({ ...credential, apiKey: "raw-secret" }),
    ).toThrow();
    expect(() =>
      Execution.CredentialSourceRefV1.parse({ ...credential, version: "credential-source-ref-v2" }),
    ).toThrow();
  });

  test("provisioning envelopes are secret-free and provider-exact", () => {
    const request = {
      version: "credential-provisioning-request-v1" as const,
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 1,
      principalId: "principal-1",
      attempt,
      providerIds: ["openai"],
      nonceRef: digest,
      expiresAt: 100,
      credentialRefs: [credential],
    };
    expect(Execution.CredentialProvisioningRequestV1.parse(request).providerIds).toEqual([
      "openai",
    ]);
    expect(() =>
      Execution.CredentialProvisioningRequestV1.parse({ ...request, apiKey: "raw-secret" }),
    ).toThrow();
    expect(() =>
      Execution.CredentialProvisioningRequestV1.parse({ ...request, providerIds: ["anthropic"] }),
    ).toThrow();
    expect(
      Execution.CredentialProvisioningReceiptV1.parse({
        version: "credential-provisioning-receipt-v1",
        runtimeId: "runtime-1",
        workerId: "worker-1",
        generation: 1,
        principalId: "principal-1",
        attempt,
        nonceRef: digest,
        acceptedCredentialDigests: [otherDigest],
        acceptedAtDbMs: 20,
      }).acceptedCredentialDigests,
    ).toEqual([otherDigest]);
  });

  test("validates typed worker identity and every WT command mapping", () => {
    const identity = Execution.AuthenticatedWorkerIdentityV1.parse({
      version: "authenticated-worker-identity-v1",
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 1,
      principalId: "principal-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(Object.keys(Execution.NativeTransitionCommandSchemasV1)).toHaveLength(120);
    const wtCommands = [
      "open",
      "record_below_quorum",
      "resolve_threshold",
      "record_duplicate",
      "stage_ambiguity",
      "select_ambiguity",
      "record_follow_up",
      "cancel",
      "expire",
      "resolve_partial",
      "reject_late",
      "remind",
      "resume",
      "close_followups_empty",
      "close_followups_present",
    ];
    for (const [index, name] of wtCommands.entries()) {
      const transitionId =
        `WT-${String(index + 1).padStart(2, "0")}` as keyof typeof Execution.NativeTransitionFactFamiliesV1;
      const waitFacts = {
        subjectId: "wait-1",
        occurredAtDbMs: 10,
        waitEvent: {
          version: "wait.cancelled.v1" as const,
          waitId: "wait-1",
          ownerRef: {
            version: "wait-owner-ref-v1" as const,
            kind: "session" as const,
            id: "session-1",
          },
          cancelledAtDbMs: 10,
          reason: "cancelled",
        },
        waitSnapshotRef: eventBlob,
      };
      const dispatchFacts = {
        subjectId: "dispatch-1",
        occurredAtDbMs: 10,
        dispatchId: "dispatch-1",
        routeId: "route-1",
        sourceSessionId: "session-1",
        sourceOwner: owner,
        destinationOwner: { ...owner, ownerKey: "work:destination" },
        dispatchDecision: "deliver",
        settlement: "pending" as const,
        dispatchSnapshotRef: eventBlob,
        destinationReceiptRef: null,
        definiteFailureProofRef: null,
      };
      const effectFacts = {
        subjectId: "effect-1",
        occurredAtDbMs: 10,
        effect: {
          version: "effect-ref-v1" as const,
          effectId: "effect-1",
          idempotencyKey: "key-1",
        },
        attempt,
        effectScope: {
          version: "effect-scope-v1" as const,
          workspace,
          resources: [
            { version: "resource-scope-v1" as const, kind: "workspace" as const, target: "**" },
          ],
          resolver: { id: "resolver", version: "v1", inputDigest: digest },
          containment: "filesystem-canonicalized" as const,
          mutationClass: "mutating" as const,
        },
        effectScopeRef: eventBlob,
        settlement: "pending" as const,
        effectSettlementRef: eventBlob,
      };
      const factsByFamily = { WT: waitFacts, DP: dispatchFacts, EF: effectFacts };
      const commandInput = {
        version: "kernel-transition-command-v1" as const,
        transitionId,
        command: `kernel.wait.${name}.v1`,
        requestId: `request-wt-${index + 1}`,
        requestHash: digest,
        identity,
        expectedHead: genesis,
        payload: {
          version: "native-transition-payload-v1" as const,
          transitionId,
          command: `kernel.wait.${name}.v1`,
          owner,
          facts: Object.fromEntries(
            Execution.NativeTransitionFactFamiliesV1[transitionId].map((family) => [
              family,
              factsByFamily[family as keyof typeof factsByFamily],
            ]),
          ),
        },
      };
      const direct = Execution.NativeTransitionCommandSchemasV1[transitionId]?.parse(commandInput);
      const parsed = Execution.KernelTransitionCommandV1.parse(commandInput);
      expect(direct?.command).toBe(parsed.command);
      expect(parsed.identity.workerId).toBe("worker-1");
    }
  });

  test("rejects unknown and mismatched commands/queries and arbitrary credential fields", () => {
    const identity = Execution.AuthenticatedWorkerIdentityV1.parse({
      version: "authenticated-worker-identity-v1",
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 1,
      principalId: "principal-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    const command = {
      version: "kernel-transition-command-v1",
      transitionId: "WT-01",
      command: "kernel.wait.open.v1",
      requestId: "request-1",
      requestHash: digest,
      identity,
      expectedHead: genesis,
      payload: {
        version: "native-transition-payload-v1",
        transitionId: "WT-01",
        command: "kernel.wait.open.v1",
        owner,
        subjectId: "wait-1",
        occurredAtDbMs: 10,
        waitEvent: {
          version: "wait.cancelled.v1",
          waitId: "wait-1",
          ownerRef: { version: "wait-owner-ref-v1", kind: "session", id: "session-1" },
          cancelledAtDbMs: 10,
          reason: "cancelled",
        },
        waitSnapshotRef: eventBlob,
      },
    };
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({ ...command, transitionId: "WT-99" }),
    ).toThrow();
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({ ...command, command: "kernel.wait.cancel.v1" }),
    ).toThrow();
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...command,
        payload: { ...command.payload, arbitraryCredential: "raw" },
      }),
    ).toThrow();
    expect(() =>
      Execution.KernelQueryV1.parse({
        version: "kernel-query-v1",
        kind: "raw_sql",
        identity,
        sql: "select 1",
      }),
    ).toThrow();
    expect(() =>
      Execution.KernelQueryResultV1.parse({
        version: "kernel-query-result-v1",
        kind: "unknown",
        events: [],
      }),
    ).toThrow();

    const queries = [
      {
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        identity,
        sessionId: identity.sessionId,
      },
      { version: "kernel-query-v1", kind: "authenticated_attempt", identity, attempt },
      { version: "kernel-query-v1", kind: "authenticated_wait", identity, waitId: "wait-1" },
    ];
    const queryFields = ["sessionId", "attempt", "waitId"];
    for (const [index, query] of queries.entries()) {
      expect(Execution.KernelQueryV1.parse(query).kind).toBe(query.kind);
      const incomplete = Object.fromEntries(
        Object.entries(query).filter(([field]) => field !== queryFields[index]),
      );
      expect(() => Execution.KernelQueryV1.parse(incomplete)).toThrow();
    }

    const queryResults = [
      { version: "kernel-query-result-v1", kind: "authenticated_transcript", messages: [] },
      {
        version: "kernel-query-result-v1",
        kind: "authenticated_attempt",
        attempt,
        events: [],
      },
      {
        version: "kernel-query-result-v1",
        kind: "authenticated_wait",
        wait: {
          version: "wait.cancelled.v1",
          waitId: "wait-1",
          ownerRef: {
            version: "wait-owner-ref-v1",
            kind: "session",
            id: identity.sessionId,
          },
          cancelledAtDbMs: 1,
          reason: "cancelled",
        },
      },
    ];
    const resultFields = ["messages", "attempt", "wait"];
    for (const [index, result] of queryResults.entries()) {
      expect(Execution.KernelQueryResultV1.parse(result).kind).toBe(result.kind);
      const incomplete = Object.fromEntries(
        Object.entries(result).filter(([field]) => field !== resultFields[index]),
      );
      expect(() => Execution.KernelQueryResultV1.parse(incomplete)).toThrow();
    }
  });
});

describe("P2 closed operation freeze surface", () => {
  const identity = {
    version: "authenticated-worker-identity-v1" as const,
    runtimeId: "runtime-1",
    workerId: "worker-1",
    generation: 1,
    principalId: "principal-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
  };
  const baseCommand = {
    version: "kernel-transition-command-v1" as const,
    requestId: "request-1",
    requestHash: digest,
    identity,
    expectedHead: genesis,
  };
  const blob = {
    version: "content-blob-ref-v1" as const,
    digest,
    byteLength: 1,
    mediaType: "application/json",
  };
  const ref = (character: string) => ({ ...blob, digest: character.repeat(64) });
  const model = { provider: "provider-1", id: "model-1" };
  const runBinding = {
    version: "run-binding-v1" as const,
    workItemId: "work-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    runId: "run-1",
  };
  const familyFacts = (id: string) => {
    const common = { subjectId: `subject:${id}`, occurredAtDbMs: 10 };
    switch (id.slice(0, 2)) {
      case "SS":
        return {
          ...common,
          sessionId: "session-1",
          parentSessionId: null,
          model,
          sessionSnapshotRef: blob,
        };
      case "SF":
        return {
          ...common,
          sessionId: "session-1",
          surfaceId: "surface-1",
          surfaceKind: "direct",
          endpointId: "endpoint-1",
          surfaceSnapshotRef: blob,
        };
      case "MS":
        return {
          ...common,
          sessionId: "session-1",
          surfaceId: "surface-1",
          messageId: "message-1",
          partId: null,
          role: "user",
          status: "complete",
          model: null,
          messageSnapshotRef: blob,
          partSnapshotRef: null,
        };
      case "RT":
        return {
          ...common,
          sessionId: "session-1",
          surfaceId: "surface-1",
          messageId: "message-1",
          routeId: "route-1",
          routeDecision: "resident",
          authoritySnapshotRef: blob,
          routeSnapshotRef: blob,
        };
      case "DP":
      case "XD":
        return {
          ...common,
          dispatchId: "dispatch-1",
          routeId: "route-1",
          sourceSessionId: "session-1",
          sourceOwner: owner,
          destinationOwner: { ...owner, ownerKey: "session:destination" },
          dispatchDecision: "deliver",
          settlement: "pending",
          dispatchSnapshotRef: blob,
          destinationReceiptRef: null,
          definiteFailureProofRef: null,
        };
      case "WI":
        return { ...common, workItemId: "work-1", sessionId: "session-1", workSnapshotRef: blob };
      case "CP":
        return {
          ...common,
          workItemId: "work-1",
          candidateId: ref("c").digest,
          runBinding,
          runBindingRef: ref("b"),
          completionSnapshotRef: ref("d"),
          candidateArtifactRef: ref("c"),
          verdictArtifactRef: null,
          admissionDecisionArtifactRef: null,
          verdictArtifactRefs: [],
        };
      case "AT":
        return {
          ...common,
          attempt,
          runBinding,
          model,
          environmentRef: {
            version: "llm-environment-v1",
            catalogSchemaVersion: 1,
            catalogSource: "bundled",
            catalogSourceVersion: "v1",
            catalogDigest: digest,
            modelDigest: digest,
            endpoint: {
              version: "llm-endpoint-ref-v1",
              kind: "default",
              valueRef: "default",
              endpointDigest: digest,
            },
            credential,
            sdkPackage: "sdk",
            adapterVersion: "v1",
            environmentDigest: digest,
          },
          environmentSnapshotRef: blob,
          attemptSnapshotRef: blob,
        };
      case "WT":
        return {
          ...common,
          waitEvent: {
            version: "wait.cancelled.v1",
            waitId: "wait-1",
            ownerRef: { version: "wait-owner-ref-v1", kind: "session", id: "session-1" },
            cancelledAtDbMs: 10,
            reason: "cancelled",
          },
          waitSnapshotRef: blob,
        };
      case "GR":
        return {
          ...common,
          grantId: "grant-1",
          attempt,
          granteeId: "actor-1",
          grantScopeRef: blob,
          grantSnapshotRef: blob,
        };
      case "SC":
        return {
          ...common,
          scheduleId: "schedule-1",
          generation: 1,
          nextFireRef: digest,
          settlementRef: otherDigest,
          scheduleSnapshotRef: blob,
        };
      case "EF":
        return {
          ...common,
          effect: { version: "effect-ref-v1", effectId: "effect-1", idempotencyKey: "key-1" },
          attempt,
          effectScope: {
            version: "effect-scope-v1",
            workspace: workspace,
            resources: [{ version: "resource-scope-v1", kind: "workspace", target: "**" }],
            resolver: { id: "resolver", version: "v1", inputDigest: digest },
            containment: "filesystem-canonicalized",
            mutationClass: "mutating",
          },
          effectScopeRef: blob,
          settlement: "confirmed",
          effectSettlementRef: blob,
        };
      default:
        throw new Error(`unknown family ${id}`);
    }
  };

  test("freezes exactly 120 core and 23 separately named configuration operations", () => {
    expect(Execution.ClosedOperationCatalogV1).toHaveLength(143);
    expect(Object.keys(Execution.NativeTransitionCommandSchemasV1)).toHaveLength(120);
    expect(Object.keys(Execution.ConfigurationOperationCommandSchemasV1)).toHaveLength(23);
    expect(Object.keys(Execution.ClosedOperationCommandSchemasV1)).toHaveLength(143);
    expect(
      Execution.ConfigurationOperationCatalogV1.map(({ id, command }) => `${id}|${command}`),
    ).toEqual([
      "AF-01|artifact.put_and_reference.v1",
      "AI-01|kernel.actor.register_identity.v1",
      "AI-02|kernel.actor.revise_identity.v1",
      "AI-03|kernel.actor.retire_identity.v1",
      "AE-01|kernel.actor.bind_endpoint.v1",
      "AE-02|kernel.actor.rebind_endpoint.v1",
      "AE-03|kernel.actor.unbind_endpoint.v1",
      "BL-01|kernel.authority.create_blacklist.v1",
      "BL-02|kernel.authority.revise_blacklist.v1",
      "BL-03|kernel.authority.revoke_blacklist.v1",
      "BL-04|kernel.authority.expire_blacklist.v1",
      "CG-01|kernel.authority.create_channel_grant.v1",
      "CG-02|kernel.authority.revise_channel_grant.v1",
      "CG-03|kernel.authority.revoke_channel_grant.v1",
      "CI-01|kernel.connector.register_installation.v1",
      "CI-02|kernel.connector.revise_definition.v1",
      "CI-03|kernel.connector.request_consent.v1",
      "CI-04|kernel.connector.grant_consent.v1",
      "CI-05|kernel.connector.request_verification.v1",
      "CI-06|kernel.connector.record_verified.v1",
      "CI-07|kernel.connector.record_verification_failed.v1",
      "CI-08|kernel.connector.disable.v1",
      "CI-09|kernel.connector.uninstall.v1",
    ]);
  });

  test("binds every core ID to one exact command schema", () => {
    for (const { id, command } of Execution.ClosedOperationCatalogV1.slice(0, 120)) {
      const candidate = {
        ...baseCommand,
        transitionId: id,
        command,
        payload: {
          version: "native-transition-payload-v1",
          transitionId: id,
          command,
          owner,
          facts: Object.fromEntries(
            Execution.NativeTransitionFactFamiliesV1[id].map((family) => [
              family,
              familyFacts(family),
            ]),
          ),
        },
      };
      expect(Execution.NativeTransitionCommandSchemasV1[id]?.parse(candidate).command).toBe(
        command,
      );
      expect(() =>
        Execution.KernelTransitionCommandV1.parse({ ...candidate, command: "unknown.v1" }),
      ).toThrow();
      expect(() =>
        Execution.KernelTransitionCommandV1.parse({
          ...candidate,
          payload: { ...candidate.payload, transitionId: "SS-99" },
        }),
      ).toThrow();
    }
  });

  test("requires exact nested facts for SF, DP, XD, and mixed-family batches", () => {
    const commandFor = (id: keyof typeof Execution.NativeTransitionFactFamiliesV1) => {
      const descriptor = Execution.ClosedOperationCatalogV1.find(
        ({ id: candidate }) => candidate === id,
      );
      if (descriptor === undefined) throw new Error(`missing ${id}`);
      return {
        ...baseCommand,
        transitionId: id,
        command: descriptor.command,
        payload: {
          version: "native-transition-payload-v1",
          transitionId: id,
          command: descriptor.command,
          owner,
          facts: Object.fromEntries(
            Execution.NativeTransitionFactFamiliesV1[id].map((family) => [
              family,
              familyFacts(family),
            ]),
          ),
        },
      };
    };

    const sf = commandFor("SF-01");
    expect(Execution.KernelTransitionCommandV1.parse(sf).payload.facts).toEqual(sf.payload.facts);
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...sf,
        payload: { ...sf.payload, facts: { SF: sf.payload.facts.SF } },
      }),
    ).toThrow();

    const mixed = commandFor("DP-05");
    expect(Object.keys(Execution.KernelTransitionCommandV1.parse(mixed).payload.facts)).toEqual([
      "DP",
      "WI",
      "AT",
      "EF",
    ]);
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...mixed,
        payload: { ...mixed.payload, facts: { ...mixed.payload.facts, generic: {} } },
      }),
    ).toThrow();

    const xd = commandFor("XD-01");
    expect(Object.keys(Execution.KernelTransitionCommandV1.parse(xd).payload.facts)).toEqual([
      "DP",
      "EF",
    ]);
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...xd,
        payload: { ...xd.payload, facts: { DP: xd.payload.facts.DP } },
      }),
    ).toThrow();

    const cp = commandFor("CP-01");
    const cpFacts = cp.payload.facts.CP;
    expect(cpFacts.candidateArtifactRef.digest).not.toBe(cpFacts.completionSnapshotRef.digest);
    expect(cpFacts.runBindingRef.digest).not.toBe(cpFacts.completionSnapshotRef.digest);
    for (const field of [
      "candidateArtifactRef",
      "verdictArtifactRef",
      "admissionDecisionArtifactRef",
      "verdictArtifactRefs",
    ] as const) {
      expect(() =>
        Execution.KernelTransitionCommandV1.parse({
          ...cp,
          payload: { ...cp.payload, facts: { CP: { ...cpFacts, [field]: undefined } } },
        }),
      ).toThrow();
    }
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...cp,
        payload: {
          ...cp.payload,
          facts: { CP: { ...cpFacts, verdictArtifactRefs: [digest] } },
        },
      }),
    ).toThrow();
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...cp,
        payload: { ...cp.payload, facts: { CP: { ...cpFacts, selfAttestedCompletion: true } } },
      }),
    ).toThrow();

    const dp = commandFor("DP-01");
    const dpFacts = dp.payload.facts.DP;
    for (const field of ["destinationReceiptRef", "definiteFailureProofRef"] as const) {
      expect(() =>
        Execution.KernelTransitionCommandV1.parse({
          ...dp,
          payload: { ...dp.payload, facts: { DP: { ...dpFacts, [field]: undefined } } },
        }),
      ).toThrow();
    }
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...dp,
        payload: { ...dp.payload, facts: { DP: { ...dpFacts, destinationReceiptRef: digest } } },
      }),
    ).toThrow();
  });

  test("requires exact operation-specific configuration payloads and rejects surplus facts", () => {
    const actorCommand = {
      ...baseCommand,
      transitionId: "AI-01",
      command: "kernel.actor.register_identity.v1",
      payload: {
        version: "configuration-operation-payload-v1",
        operationId: "AI-01",
        command: "kernel.actor.register_identity.v1",
        owner,
        subjectId: "actor-1",
        recordVersion: 1,
        occurredAtDbMs: 10,
        configurationSnapshotRef: blob,
        identity: {
          id: "actor-1",
          kind: "human",
          trustTier: "owner",
          relationship: "owner",
          displayName: "Owner",
        },
      },
    };
    expect(Execution.KernelTransitionCommandV1.parse(actorCommand).transitionId).toBe("AI-01");
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...actorCommand,
        payload: { ...actorCommand.payload, identity: undefined },
      }),
    ).toThrow();
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...actorCommand,
        payload: { ...actorCommand.payload, rawSecret: "forbidden" },
      }),
    ).toThrow();
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({ ...actorCommand, transitionId: "AI-02" }),
    ).toThrow();

    const artifactCommand = {
      ...baseCommand,
      transitionId: "AF-01",
      command: "artifact.put_and_reference.v1",
      payload: {
        version: "configuration-operation-payload-v1",
        operationId: "AF-01",
        command: "artifact.put_and_reference.v1",
        owner,
        subjectId: "artifact-1",
        recordVersion: 1,
        occurredAtDbMs: 10,
        artifactId: "artifact-1",
        contentRef: blob,
        title: "result",
        configurationSnapshotRef: blob,
      },
    };
    expect(Execution.KernelTransitionCommandV1.parse(artifactCommand).transitionId).toBe("AF-01");
    expect(() =>
      Execution.KernelTransitionCommandV1.parse({
        ...artifactCommand,
        payload: { ...artifactCommand.payload, contentRef: undefined },
      }),
    ).toThrow();
  });

  test("closes event payload selection to exact literal schemas", () => {
    expect(Object.keys(Ledger.NativeEventPayloadSchemasV1)).toHaveLength(97);
    const payload = {
      version: "native-event-payload-v1" as const,
      eventType: "actor.identity_registered.v1" as const,
      subjectId: "actor-1",
      occurredAtDbMs: 10,
      configurationSnapshotRef: blob,
    };
    expect(Ledger.NativeEventPayloadSchemasV1[payload.eventType]?.parse(payload)).toEqual(payload);
    expect(() =>
      Ledger.NativeEventPayloadSchemasV1[payload.eventType]?.parse({
        ...payload,
        eventType: "actor.identity_revised.v1",
      }),
    ).toThrow();
    expect(() => Ledger.NativeEventPayloadV1.parse({ ...payload, reducerEscape: {} })).toThrow();
  });
});
