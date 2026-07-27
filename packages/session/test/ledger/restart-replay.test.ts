import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@openomni/protocol";
import type { LedgerQuery } from "../../src/ledger/query.js";
import { openLedgerRuntime } from "../../src/ledger/runtime.js";

const TABLES = [
  "session_projection",
  "message_projection",
  "part_projection",
  "surface_binding_projection",
  "artifact_reference_projection",
  "actor_identity_projection",
  "actor_endpoint_projection",
  "blacklist_projection",
  "channel_grant_projection",
  "worker_grant_projection",
  "schedule_projection",
  "connector_installation_projection",
  "work_projection",
  "attempt_projection",
  "wait_projection",
  "dispatch_projection",
  "completion_projection",
  "effect_projection",
  "projection_checkpoint",
] as const;

describe("production projection restart replay", () => {
  test("rebuilds every projection family from genesis with byte-identical rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-projection-replay-"));
    const dbPath = join(directory, "ledger.sqlite");
    const blobs: Uint8Array[] = [];
    const artifact = (value: Record<string, unknown>) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      blobs.push(bytes);
      return {
        version: "content-blob-ref-v1" as const,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: "application/json",
      };
    };
    const snapshot = (family: string, state: Record<string, unknown>) =>
      artifact({ version: `${family}-projection-state-v1`, state });
    try {
      const owner = { version: "ledger-owner-v1" as const, ownerKey: "owner-1" };
      const requestId = "all-projection-families";
      const base = (eventType: Ledger.NativeEventTypeV1, subjectId: string) => ({
        version: "native-event-payload-v1" as const,
        eventType,
        subjectId,
        occurredAtDbMs: 123,
      });
      const candidateArtifactRef = artifact({
        version: "completion-report-v1",
        summary: "complete",
        claims: [
          { statement: "first claim", evidenceIds: ["evidence-1"] },
          { statement: "second claim", evidenceIds: ["evidence-2"] },
        ],
        caveats: [],
        followUps: [],
      });
      const verdictArtifactRef = artifact({
        version: "completion-claim-verdict-v1",
        candidateRef: candidateArtifactRef.digest,
        claimIndex: 0,
        status: "passed",
      });
      const secondVerdictArtifactRef = artifact({
        version: "completion-claim-verdict-v1",
        candidateRef: candidateArtifactRef.digest,
        claimIndex: 1,
        status: "passed",
      });
      const admissionDecisionArtifactRef = artifact({
        version: "completion-admission-decision-v1",
        candidateRef: candidateArtifactRef.digest,
        verdictRefs: [verdictArtifactRef.digest, secondVerdictArtifactRef.digest],
      });
      const runBindingRef = artifact({
        version: "run-binding-v1",
        candidateId: candidateArtifactRef.digest,
        workItemId: "work-1",
        attemptId: "attempt-1",
      });
      const destinationReceiptRef = artifact({
        version: "destination-receipt-v1",
        dispatchId: "dispatch-1",
      });
      const definiteFailureProofRef = artifact({
        version: "definite-failure-proof-v1",
        dispatchId: "dispatch-2",
        destinationState: "absent",
      });
      const deliveredDispatchSnapshotRef = snapshot("dispatch", {
        dispatchId: "dispatch-1",
        destinationReceiptRef,
        definiteFailureProofRef: null,
      });
      const failedDispatchSnapshotRef = snapshot("dispatch", {
        dispatchId: "dispatch-2",
        destinationReceiptRef: null,
        definiteFailureProofRef,
      });
      const completionState = (
        verdictRefs: readonly (typeof verdictArtifactRef)[],
        decisionRef: string | null,
      ) => ({
        candidateId: candidateArtifactRef.digest,
        candidateRef: candidateArtifactRef.digest,
        workItemId: "work-1",
        attemptId: "attempt-1",
        sessionId: "session-1",
        runId: "run-1",
        status: decisionRef === null ? "candidate" : "admitted",
        verdictRefs: verdictRefs.map((ref) => ref.digest),
        decisionRef,
        stakesAsOfLedgerSeq: 9,
        stakesAsOfDbMs: 123,
        candidateArtifactRef,
        verdictArtifactRef: decisionRef === null ? (verdictRefs.at(-1) ?? null) : null,
        admissionDecisionArtifactRef: decisionRef === null ? null : admissionDecisionArtifactRef,
        verdictArtifactRefs: verdictRefs,
      });
      const payloads: Ledger.NativeEventPayloadV1[] = [
        {
          ...base("session.opened.v1", "session-1"),
          sessionId: "session-1",
          parentSessionId: null,
          model: { provider: "test", id: "model" },
          sessionSnapshotRef: snapshot("session", { id: "session-1" }),
        },
        {
          ...base("surface.bound.v1", "surface-1"),
          sessionId: "session-1",
          surfaceId: "surface-1",
          surfaceKind: "test",
          endpointId: "endpoint-1",
          surfaceSnapshotRef: snapshot("surface", {
            surfaceKey: "surface-1",
            sessionId: "session-1",
          }),
        },
        {
          ...base("message.part_appended.v1", "message-1"),
          sessionId: "session-1",
          surfaceId: "surface-1",
          messageId: "message-1",
          partId: "part-1",
          role: "user",
          status: "complete",
          model: null,
          messageSnapshotRef: snapshot("message", { id: "message-1", sessionId: "session-1" }),
          partSnapshotRef: snapshot("part", { id: "part-1", partOrdinal: 0 }),
        },
        {
          ...base("message.part_appended.v1", "message-2"),
          sessionId: "session-1",
          surfaceId: "surface-1",
          messageId: "message-2",
          partId: "part-2",
          role: "assistant",
          status: "complete",
          model: { provider: "test", id: "model" },
          messageSnapshotRef: snapshot("message", {
            id: "message-2",
            sessionId: "session-1",
          }),
          partSnapshotRef: snapshot("part", { id: "part-2", partOrdinal: 1 }),
        },
        {
          ...base("message.part_appended.v1", "message-1"),
          sessionId: "session-1",
          surfaceId: "surface-1",
          messageId: "message-1",
          partId: "part-3",
          role: "user",
          status: "complete",
          model: null,
          messageSnapshotRef: snapshot("message", {
            id: "message-1",
            sessionId: "session-1",
          }),
          partSnapshotRef: snapshot("part", { id: "part-3", partOrdinal: 2 }),
        },
        {
          ...base("kernel.route.decided.v1", "route-1"),
          sessionId: "session-1",
          surfaceId: "surface-1",
          messageId: "message-1",
          routeId: "route-1",
          routeDecision: "accept",
          authoritySnapshotRef: snapshot("route", { routeId: "route-1" }),
          routeSnapshotRef: snapshot("route", { routeId: "route-1" }),
        },
        {
          ...base("dispatch.pending.v1", "dispatch-1"),
          dispatchId: "dispatch-1",
          routeId: "route-1",
          sourceSessionId: "session-1",
          sourceOwner: owner,
          destinationOwner: { ...owner, ownerKey: "owner-2" },
          dispatchDecision: "send",
          settlement: "pending",
          destinationReceiptRef: null,
          definiteFailureProofRef: null,
          dispatchSnapshotRef: snapshot("dispatch", {
            dispatchId: "dispatch-1",
            destinationReceiptRef: null,
            definiteFailureProofRef: null,
          }),
        },
        {
          ...base("dispatch.delivered.v1", "dispatch-1"),
          dispatchId: "dispatch-1",
          routeId: "route-1",
          sourceSessionId: "session-1",
          sourceOwner: owner,
          destinationOwner: { ...owner, ownerKey: "owner-2" },
          dispatchDecision: "send",
          settlement: "delivered",
          destinationReceiptRef,
          definiteFailureProofRef: null,
          dispatchSnapshotRef: deliveredDispatchSnapshotRef,
        },
        {
          ...base("dispatch.failed.v1", "dispatch-2"),
          dispatchId: "dispatch-2",
          routeId: "route-1",
          sourceSessionId: "session-1",
          sourceOwner: owner,
          destinationOwner: { ...owner, ownerKey: "owner-3" },
          dispatchDecision: "send",
          settlement: "definite_failed",
          destinationReceiptRef: null,
          definiteFailureProofRef,
          dispatchSnapshotRef: failedDispatchSnapshotRef,
        },
        {
          ...base("work.created.v1", "work-1"),
          workItemId: "work-1",
          sessionId: "session-1",
          workSnapshotRef: snapshot("work", { id: "work-1", sessionId: "session-1" }),
        },
        {
          ...base("attempt.allocated.v1", "attempt-1"),
          workItemId: "work-1",
          attemptId: "attempt-1",
          attemptSeq: 1,
          sessionId: "session-1",
          runId: "run-1",
          model: { provider: "test", id: "model" },
          environmentSnapshotRef: snapshot("attempt", {
            attemptId: "attempt-1",
            workItemId: "work-1",
            sessionId: "session-1",
          }),
          attemptSnapshotRef: snapshot("attempt", {
            attemptId: "attempt-1",
            workItemId: "work-1",
            sessionId: "session-1",
          }),
        },
        {
          ...base("completion.candidate.submitted.v1", candidateArtifactRef.digest),
          workItemId: "work-1",
          candidateId: candidateArtifactRef.digest,
          runBindingRef,
          candidateArtifactRef,
          verdictArtifactRef: null,
          admissionDecisionArtifactRef: null,
          verdictArtifactRefs: [],
          completionSnapshotRef: snapshot("completion", completionState([], null)),
        },
        {
          ...base("completion.claim_verdict_recorded.v1", candidateArtifactRef.digest),
          workItemId: "work-1",
          candidateId: candidateArtifactRef.digest,
          runBindingRef,
          candidateArtifactRef,
          verdictArtifactRef,
          admissionDecisionArtifactRef: null,
          verdictArtifactRefs: [verdictArtifactRef],
          completionSnapshotRef: snapshot(
            "completion",
            completionState([verdictArtifactRef], null),
          ),
        },
        {
          ...base("completion.claim_verdict_recorded.v1", candidateArtifactRef.digest),
          workItemId: "work-1",
          candidateId: candidateArtifactRef.digest,
          runBindingRef,
          candidateArtifactRef,
          verdictArtifactRef: secondVerdictArtifactRef,
          admissionDecisionArtifactRef: null,
          verdictArtifactRefs: [verdictArtifactRef, secondVerdictArtifactRef],
          completionSnapshotRef: snapshot(
            "completion",
            completionState([verdictArtifactRef, secondVerdictArtifactRef], null),
          ),
        },
        {
          ...base("completion.decision_recorded.v1", candidateArtifactRef.digest),
          workItemId: "work-1",
          candidateId: candidateArtifactRef.digest,
          runBindingRef,
          candidateArtifactRef,
          verdictArtifactRef: null,
          admissionDecisionArtifactRef,
          verdictArtifactRefs: [verdictArtifactRef, secondVerdictArtifactRef],
          completionSnapshotRef: snapshot(
            "completion",
            completionState(
              [verdictArtifactRef, secondVerdictArtifactRef],
              admissionDecisionArtifactRef.digest,
            ),
          ),
        },
        {
          ...base("wait.opened.v1", "wait-1"),
          waitId: "wait-1",
          waitEventVersion: "v1",
          waitSnapshotRef: snapshot("wait", {
            waitId: "wait-1",
            workItemId: "work-1",
            attemptId: "attempt-1",
            sessionId: "session-1",
          }),
        },
        {
          ...base("grant.created.v1", "grant-1"),
          grantId: "grant-1",
          workItemId: "work-1",
          attemptId: "attempt-1",
          granteeId: "worker-1",
          grantScopeRef: snapshot("worker-grant", { grantId: "grant-1", workerRunId: "run-1" }),
          grantSnapshotRef: snapshot("worker-grant", {
            grantId: "grant-1",
            workerRunId: "run-1",
          }),
        },
        {
          ...base("schedule.created.v1", "schedule-1"),
          scheduleId: "schedule-1",
          generation: 0,
          nextFireRef: null,
          settlementRef: null,
          scheduleSnapshotRef: snapshot("schedule", { scheduleId: "schedule-1" }),
        },
        {
          ...base("effect.intent.v1", "effect-1"),
          effectId: "effect-1",
          idempotencyKey: "key-1",
          workItemId: "work-1",
          attemptId: "attempt-1",
          effectScopeRef: snapshot("effect", {
            effectId: "effect-1",
            workspaceId: "workspace-1",
            workItemId: "work-1",
            attemptId: "attempt-1",
          }),
          settlement: "pending",
          effectSettlementRef: snapshot("effect", {
            effectId: "effect-1",
            workspaceId: "workspace-1",
            workItemId: "work-1",
            attemptId: "attempt-1",
          }),
        },
      ].map((payload) => {
        const schema = Ledger.NativeEventPayloadSchemasV1[payload.eventType];
        if (!schema) throw new Error(`missing native payload schema for ${payload.eventType}`);
        return schema.parse(payload);
      });
      const events = payloads.map((payload, index) =>
        Ledger.EventV1.parse({
          version: "ledger-event-v1",
          eventId: `event-${index}`,
          eventType: payload.eventType,
          eventVersion: 1,
          owner,
          payload,
          provenance: {
            version: "native-event-provenance-v1",
            principalId: "principal-1",
            requestId,
          },
        }),
      );
      const request = Ledger.AppendBatch.parse({
        version: "ledger-append-batch-request-v1",
        requestId,
        requestHash: "a".repeat(64),
        principalId: "principal-1",
        expectedHead: {
          version: "ledger-head-v1",
          owner,
          ownerSeq: 0,
          eventHash: Ledger.GENESIS_V1,
        },
        batch: { version: "ledger-batch-v1", batchId: "batch-1", owner, events },
      });
      const runtime = openLedgerRuntime({ dbPath });

      await runtime.append(request, { artifactBlobs: blobs.map((bytes) => ({ bytes })) });
      const liveProjection = await runtime.query((query) =>
        readTypedProjectionRows(query, candidateArtifactRef.digest),
      );
      expect(liveProjection.session).toMatchObject({
        sessionId: "session-1",
        sourceEventId: "event-0",
        sourceOwnerSeq: 1,
        sourceLedgerSeq: 1,
        asOfLedgerSeq: payloads.length,
      });
      expect(liveProjection.session?.state).toMatchObject({ id: "session-1" });
      expect(liveProjection.message?.messageId).toBe("message-1");
      expect(liveProjection.parts).toHaveLength(2);
      expect(liveProjection.messages.map(({ messageId }) => messageId)).toEqual([
        "message-2",
        "message-1",
      ]);
      expect(liveProjection.parts.map(({ partId, partOrdinal }) => [partId, partOrdinal])).toEqual([
        ["part-1", 0],
        ["part-3", 2],
      ]);
      expect(
        liveProjection.messageTwoParts.map(({ partId, partOrdinal }) => [partId, partOrdinal]),
      ).toEqual([["part-2", 1]]);
      expect(liveProjection.attempt?.attemptId).toBe("attempt-1");
      expect(liveProjection.wait?.waitId).toBe("wait-1");
      expect(liveProjection.schedule?.scheduleId).toBe("schedule-1");
      expect(liveProjection.effect?.effectId).toBe("effect-1");
      expect(liveProjection.completion?.state).toMatchObject({
        candidateId: candidateArtifactRef.digest,
        candidateRef: candidateArtifactRef.digest,
        verdictRefs: [verdictArtifactRef.digest, secondVerdictArtifactRef.digest],
        decisionRef: admissionDecisionArtifactRef.digest,
        candidateArtifactRef,
        verdictArtifactRefs: [verdictArtifactRef, secondVerdictArtifactRef],
        verdictArtifactRef: null,
        admissionDecisionArtifactRef,
      });
      expect(liveProjection.completion?.state).not.toMatchObject({
        candidateRef: expect.objectContaining({ version: "content-blob-ref-v1" }),
      });
      expect(liveProjection.dispatch?.state).toMatchObject({
        dispatchId: "dispatch-1",
        destinationReceiptRef,
        definiteFailureProofRef: null,
      });
      expect(liveProjection.failedDispatch?.state).toMatchObject({
        dispatchId: "dispatch-2",
        destinationReceiptRef: null,
        definiteFailureProofRef,
      });
      expect(
        new Set([
          candidateArtifactRef.digest,
          verdictArtifactRef.digest,
          secondVerdictArtifactRef.digest,
          admissionDecisionArtifactRef.digest,
          destinationReceiptRef.digest,
          definiteFailureProofRef.digest,
          deliveredDispatchSnapshotRef.digest,
          failedDispatchSnapshotRef.digest,
        ]).size,
      ).toBe(8);
      expect(destinationReceiptRef).not.toEqual(deliveredDispatchSnapshotRef);
      expect(definiteFailureProofRef).not.toEqual(failedDispatchSnapshotRef);
      expect(Object.isFrozen(liveProjection.session?.state)).toBe(true);
      await runtime.close();

      const before = readRows(dbPath);
      expect(
        (before.projection_checkpoint as { projection_name: string }[])
          .map(({ projection_name }) => projection_name)
          .sort(),
      ).toEqual([
        "native.actor-endpoint",
        "native.actor-identity",
        "native.artifact-reference",
        "native.attempt",
        "native.blacklist",
        "native.channel-grant",
        "native.completion",
        "native.connector-installation",
        "native.dispatch",
        "native.effect",
        "native.message",
        "native.part",
        "native.route",
        "native.schedule",
        "native.session",
        "native.surface",
        "native.wait",
        "native.work",
        "native.worker-grant",
      ]);
      const tamper = new Database(dbPath, { strict: true });
      const originalPayloadRow = tamper
        .query("SELECT canonical_payload FROM ledger_event WHERE event_id = ?")
        .get("event-0") as { readonly canonical_payload: string };
      const tamperedPayload = JSON.parse(originalPayloadRow.canonical_payload) as Record<
        string,
        unknown
      >;
      tamper
        .query("UPDATE ledger_event SET canonical_payload = ? WHERE event_id = ?")
        .run(JSON.stringify({ ...tamperedPayload, occurredAtDbMs: 124 }), "event-0");
      tamper
        .query(
          "UPDATE session_projection SET state_json = ?, source_event_id = ? WHERE session_id = ?",
        )
        .run(
          JSON.stringify({ id: "session-1", fabricated: true }),
          "fabricated-event",
          "session-1",
        );
      tamper
        .query(
          `INSERT INTO session_projection
           (session_id, owner_key, state_json, source_event_id, source_owner_seq,
            source_ledger_seq, source_owner_hash, updated_at_db_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("fabricated-session", "owner-1", "{}", "fabricated", 999, 999, "f".repeat(64), 0);
      tamper.close();

      const tamperedCache = readRows(dbPath);
      expect(() => openLedgerRuntime({ dbPath })).toThrow("content hash mismatch");
      expect(readRows(dbPath)).toEqual(tamperedCache);
      const restore = new Database(dbPath, { strict: true });
      restore
        .query("UPDATE ledger_event SET canonical_payload = ? WHERE event_id = ?")
        .run(originalPayloadRow.canonical_payload, "event-0");
      restore.close();

      const restarted = openLedgerRuntime({ dbPath });
      const replayedProjection = await restarted.query((query) =>
        readTypedProjectionRows(query, candidateArtifactRef.digest),
      );
      expect(replayedProjection).toEqual(liveProjection);
      await restarted.close();
      expect(readRows(dbPath)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rebuilds native Wait correlation facts and fail-closed candidate exclusions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-wait-correlation-replay-"));
    const dbPath = join(directory, "ledger.sqlite");
    const owner = { version: "ledger-owner-v1" as const, ownerKey: "wait-owner" };
    const blobs: Uint8Array[] = [];
    const waitEvent = (waitId: string, state: Record<string, unknown>): Ledger.EventV1 => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ version: "wait-projection-state-v1", state }),
      );
      blobs.push(bytes);
      const waitSnapshotRef = {
        version: "content-blob-ref-v1" as const,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: "application/json",
      };
      return Ledger.EventV1.parse({
        version: "ledger-event-v1",
        eventId: `event-${waitId}`,
        eventType: "wait.opened.v1",
        eventVersion: 1,
        owner,
        payload: {
          version: "native-event-payload-v1",
          eventType: "wait.opened.v1",
          subjectId: waitId,
          occurredAtDbMs: 50,
          waitId,
          waitEventVersion: "v1",
          waitSnapshotRef,
        },
        provenance: {
          version: "native-event-provenance-v1",
          principalId: "principal-1",
          requestId: "wait-correlation-fixture",
        },
      });
    };
    const state = (
      waitId: string,
      tokenHash: string,
      threadId: string,
      status: "open" | "resolved" = "open",
      deadline = 200,
      extra: Record<string, unknown> = {},
    ) => ({
      waitId,
      workItemId: `work-${waitId}`,
      attemptId: `attempt-${waitId}`,
      sessionId: "session-waits",
      status,
      opened: {
        endpointId: "endpoint-1",
        channelId: "channel-1",
        correlation: { version: "wait-correlation-v1", tokenHash, threadId },
        deadline,
      },
      ...extra,
    });
    const events = [
      waitEvent("exact", state("exact", "a".repeat(64), "thread-exact")),
      waitEvent("other", state("other", "b".repeat(64), "thread-other")),
      waitEvent("ambiguous-a", state("ambiguous-a", "c".repeat(64), "thread-ambiguous")),
      waitEvent("ambiguous-b", state("ambiguous-b", "c".repeat(64), "thread-ambiguous")),
      waitEvent("deadline", state("deadline", "d".repeat(64), "thread-deadline", "open", 99)),
      waitEvent(
        "follow-up",
        state("follow-up", "e".repeat(64), "thread-follow-up", "resolved", 200, {
          followUpEventIds: ["follow-up-event"],
          followUpsClosedAtDbMs: 90,
        }),
      ),
      waitEvent(
        "duplicate-transport",
        state("duplicate-transport", "f".repeat(64), "thread-duplicate", "resolved", 200, {
          responsesByTransportId: {
            "transport-1": { eventId: "response-event", responseHash: "1".repeat(64) },
          },
        }),
      ),
    ];
    const correlationEvidence = (query: LedgerQuery) => {
      const candidates = query.waitCandidates("endpoint-1", "channel-1");
      const correlate = (tokenHash: string, threadId: string) =>
        candidates
          .filter(({ state: projected }) => {
            const opened = projected.opened as Record<string, unknown>;
            const correlation = opened.correlation as Record<string, unknown>;
            return (
              projected.status === "open" &&
              (opened.deadline as number) >= 100 &&
              opened.endpointId === "endpoint-1" &&
              opened.channelId === "channel-1" &&
              correlation.tokenHash === tokenHash &&
              correlation.threadId === threadId
            );
          })
          .map(({ waitId }) => waitId);
      return {
        exact: correlate("a".repeat(64), "thread-exact"),
        none: correlate("a".repeat(64), "wrong-thread"),
        ambiguous: correlate("c".repeat(64), "thread-ambiguous"),
        deadline: correlate("d".repeat(64), "thread-deadline"),
        followUpExcluded: correlate("e".repeat(64), "thread-follow-up"),
        duplicateTransportExcluded: correlate("f".repeat(64), "thread-duplicate"),
        candidateIds: candidates.map(({ waitId }) => waitId),
        followUp: query.wait("follow-up")?.state,
        duplicateTransport: query.wait("duplicate-transport")?.state,
      };
    };
    try {
      const runtime = openLedgerRuntime({ dbPath });
      await runtime.append(
        Ledger.AppendBatch.parse({
          version: "ledger-append-batch-request-v1",
          requestId: "wait-correlation-fixture",
          requestHash: "a".repeat(64),
          principalId: "principal-1",
          expectedHead: {
            version: "ledger-head-v1",
            owner,
            ownerSeq: 0,
            eventHash: Ledger.GENESIS_V1,
          },
          batch: {
            version: "ledger-batch-v1",
            batchId: "wait-correlation-fixture",
            owner,
            events,
          },
        }),
        { artifactBlobs: blobs.map((bytes) => ({ bytes })) },
      );
      const live = await runtime.query(correlationEvidence);
      expect(live.exact).toEqual(["exact"]);
      expect(live.none).toEqual([]);
      expect(live.ambiguous).toEqual(["ambiguous-a", "ambiguous-b"]);
      expect(live.deadline).toEqual([]);
      expect(live.followUpExcluded).toEqual([]);
      expect(live.duplicateTransportExcluded).toEqual([]);
      expect(live.candidateIds).toEqual([
        "exact",
        "other",
        "ambiguous-a",
        "ambiguous-b",
        "deadline",
      ]);
      expect(live.followUp).toMatchObject({
        status: "resolved",
        followUpEventIds: ["follow-up-event"],
        followUpsClosedAtDbMs: 90,
      });
      expect(live.duplicateTransport).toMatchObject({
        status: "resolved",
        responsesByTransportId: {
          "transport-1": { eventId: "response-event", responseHash: "1".repeat(64) },
        },
      });
      await runtime.close();

      const reopened = openLedgerRuntime({ dbPath });
      expect(await reopened.query(correlationEvidence)).toEqual(live);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a missing referenced blob before committing an event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-projection-rollback-"));
    const dbPath = join(directory, "ledger.sqlite");
    try {
      const runtime = openLedgerRuntime({ dbPath });
      const owner = { version: "ledger-owner-v1" as const, ownerKey: "owner-1" };
      const event = Ledger.EventV1.parse({
        version: "ledger-event-v1",
        eventId: "missing-ref",
        eventType: "session.opened.v1",
        eventVersion: 1,
        owner,
        payload: {
          version: "native-event-payload-v1",
          eventType: "session.opened.v1",
          subjectId: "session-1",
          occurredAtDbMs: 0,
          sessionId: "session-1",
          parentSessionId: null,
          model: { provider: "test", id: "model" },
          sessionSnapshotRef: {
            version: "content-blob-ref-v1",
            digest: "f".repeat(64),
            byteLength: 1,
            mediaType: "application/json",
          },
        },
        provenance: {
          version: "native-event-provenance-v1",
          principalId: "principal-1",
          requestId: "missing-ref",
        },
      });
      await expect(
        runtime.append(
          Ledger.AppendBatch.parse({
            version: "ledger-append-batch-request-v1",
            requestId: "missing-ref",
            requestHash: "a".repeat(64),
            principalId: "principal-1",
            expectedHead: {
              version: "ledger-head-v1",
              owner,
              ownerSeq: 0,
              eventHash: Ledger.GENESIS_V1,
            },
            batch: { version: "ledger-batch-v1", batchId: "missing-ref", owner, events: [event] },
          }),
        ),
      ).rejects.toThrow("is missing");
      expect(
        await runtime.query((query) => query.eventsByLedgerSequence({ throughLedgerSeq: 10 })),
      ).toEqual([]);
      await runtime.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function readTypedProjectionRows(query: LedgerQuery, candidateId: string) {
  return {
    session: query.session("session-1"),
    message: query.message("message-1"),
    messages: query.messagesBySession("session-1"),
    parts: query.partsByMessage("message-1"),
    messageTwoParts: query.partsByMessage("message-2"),
    surface: query.surfaceBinding("surface-1"),
    artifact: query.artifactReference("c".repeat(64)),
    actor: query.actorIdentity("actor-1"),
    endpoint: query.actorEndpoint("endpoint-1"),
    blacklist: query.blacklistEntries(),
    channelGrant: query.channelGrant("channel-grant-1"),
    workerGrant: query.workerGrant("grant-1"),
    schedule: query.schedule("schedule-1"),
    connector: query.connectorInstallation("installation-1"),
    work: query.work("work-1"),
    attempt: query.attempt("attempt-1"),
    wait: query.wait("wait-1"),
    dispatch: query.dispatch("dispatch-1"),
    failedDispatch: query.dispatch("dispatch-2"),
    completion: query.completion(candidateId),
    effect: query.effect("effect-1"),
  };
}

function readRows(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    return Object.fromEntries(
      TABLES.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY 1`).all()]),
    );
  } finally {
    db.close();
  }
}
