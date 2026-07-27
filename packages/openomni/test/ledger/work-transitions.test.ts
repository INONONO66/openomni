import { describe, expect, test } from "bun:test";
import type { Execution, Ledger } from "@openomni/protocol";
import { reduceAttemptProjections } from "../../src/ledger/reducers/attempt.js";
import { reduceCompletionProjection } from "../../src/ledger/reducers/completion.js";
import { reduceWorkProjection } from "../../src/ledger/reducers/work.js";
import {
  workAttemptCompletionEventSubject,
  workAttemptCompletionGuardReason,
} from "../../src/ledger/transitions/work-attempt-completion.js";

const owner = { version: "ledger-owner-v1", ownerKey: "work:work-1" } as const;
const digest = (character: string) => character.repeat(64);
const completionRef = (character: string) => ({
  version: "content-blob-ref-v1" as const,
  digest: digest(character),
  byteLength: 1,
  mediaType: "application/json",
});
const attempt = (attemptId: string, attemptSeq: number): Ledger.AttemptRefV1 => ({
  version: "attempt-ref-v1",
  workItemId: "work-1",
  attemptId,
  attemptSeq,
});

function envelope(
  eventType: Ledger.NativeEventTypeV1,
  subjectId: string,
  ownerSeq: number,
  dataRef?: string,
): Ledger.EnvelopeV1 {
  const requestId = `request-${ownerSeq}`;
  return {
    version: "ledger-envelope-v1",
    envelopeVersion: 1,
    ledgerSeq: ownerSeq,
    ownerSeq,
    previousEventHash: ownerSeq === 1 ? "GENESIS_V1" : digest("a"),
    eventHash: digest("b"),
    event: {
      version: "ledger-event-v1",
      eventId: `event-${ownerSeq}`,
      eventType,
      eventVersion: 1,
      owner,
      payload: {
        version: "native-event-payload-v1",
        eventType,
        subjectId,
        occurredAtDbMs: 1_000 + ownerSeq,
        ...(eventType.startsWith("work.")
          ? {
              workItemId: "work-1",
              sessionId: "session-1",
              workSnapshotRef: {
                version: "content-blob-ref-v1",
                digest: dataRef ?? digest("f"),
                byteLength: 1,
                mediaType: "application/json",
              },
            }
          : {}),
        ...(eventType.startsWith("attempt.")
          ? {
              workItemId: "work-1",
              attemptId: subjectId,
              attemptSeq: subjectId.endsWith("2") ? 2 : 1,
              sessionId: "session-1",
              runId: subjectId === "attempt-1" ? "run-1" : `run-${subjectId}`,
              model: { provider: "provider", id: "model" },
              environmentSnapshotRef: {
                version: "content-blob-ref-v1",
                digest: digest("e"),
                byteLength: 1,
                mediaType: "application/json",
              },
              attemptSnapshotRef: {
                version: "content-blob-ref-v1",
                digest: dataRef ?? digest("f"),
                byteLength: 1,
                mediaType: "application/json",
              },
            }
          : {}),
        ...(eventType.startsWith("completion.")
          ? {
              workItemId: "work-1",
              candidateId: digest("a"),
              runBindingRef: {
                version: "content-blob-ref-v1",
                digest: digest("d"),
                byteLength: 1,
                mediaType: "application/json",
              },
              completionSnapshotRef: {
                version: "content-blob-ref-v1",
                digest: digest("f"),
                byteLength: 1,
                mediaType: "application/json",
              },
              candidateArtifactRef: {
                version: "content-blob-ref-v1",
                digest: digest("a"),
                byteLength: 1,
                mediaType: "application/json",
              },
              verdictArtifactRef:
                eventType === "completion.claim_verdict_recorded.v1"
                  ? {
                      version: "content-blob-ref-v1",
                      digest: dataRef ?? digest("b"),
                      byteLength: 1,
                      mediaType: "application/json",
                    }
                  : null,
              admissionDecisionArtifactRef:
                eventType === "completion.decision_recorded.v1"
                  ? {
                      version: "content-blob-ref-v1",
                      digest: dataRef ?? digest("c"),
                      byteLength: 1,
                      mediaType: "application/json",
                    }
                  : null,
              verdictArtifactRefs:
                eventType === "completion.candidate.submitted.v1"
                  ? []
                  : [
                      {
                        version: "content-blob-ref-v1",
                        digest: digest("b"),
                        byteLength: 1,
                        mediaType: "application/json",
                      },
                    ],
            }
          : {}),
        ...(eventType.startsWith("effect.")
          ? {
              effectId: subjectId,
              idempotencyKey: dataRef ?? digest("f"),
              workItemId: "work-1",
              attemptId: "attempt-1",
              effectScopeRef: {
                version: "content-blob-ref-v1",
                digest: digest("d"),
                byteLength: 1,
                mediaType: "application/json",
              },
              settlement: "confirmed",
              effectSettlementRef: {
                version: "content-blob-ref-v1",
                digest: dataRef ?? digest("f"),
                byteLength: 1,
                mediaType: "application/json",
              },
            }
          : {}),
      },
      provenance: { version: "native-event-provenance-v1", principalId: "principal-1", requestId },
    },
    batch: { version: "ledger-batch-position-v1", batchId: `batch-${ownerSeq}`, index: 0, size: 1 },
    requestId,
    requestHash: digest("c"),
    principalId: "principal-1",
    committedAtDbMs: 1_000 + ownerSeq,
  } as Ledger.EnvelopeV1;
}

function command(
  transitionId: string,
  options: { attempt?: Ledger.AttemptRefV1; evidenceRef?: string } = {},
): Execution.KernelTransitionCommandV1 {
  const completionFacts = transitionId.startsWith("CP-")
    ? {
        CP: {
          subjectId: "work-1",
          occurredAtDbMs: 2_000,
          workItemId: "work-1",
          candidateId: digest("a"),
          runBinding: {
            version: "run-binding-v1" as const,
            workItemId: "work-1",
            attemptId: "attempt-1",
            sessionId: "session-1",
            runId: "run-1",
          },
          runBindingRef: completionRef("d"),
          completionSnapshotRef: completionRef("f"),
          candidateArtifactRef: completionRef("a"),
          verdictArtifactRef: transitionId === "CP-02" ? completionRef("b") : null,
          admissionDecisionArtifactRef: transitionId === "CP-04" ? completionRef("c") : null,
          verdictArtifactRefs: transitionId === "CP-01" ? [] : [completionRef("b")],
        },
      }
    : undefined;
  return {
    version: "kernel-transition-command-v1",
    transitionId,
    command: `test.${transitionId}`,
    requestId: `command-${transitionId}`,
    requestHash: digest("d"),
    identity: {
      version: "authenticated-worker-identity-v1",
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 1,
      principalId: "principal-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: options.attempt?.attemptId ?? "attempt-1",
    },
    expectedHead: { version: "ledger-head-v1", owner, ownerSeq: 0, eventHash: "GENESIS_V1" },
    payload: {
      version: "native-transition-payload-v1",
      transitionId,
      command: `test.${transitionId}`,
      owner,
      subjectId: transitionId.startsWith("AT-")
        ? (options.attempt?.attemptId ?? "attempt-1")
        : "work-1",
      ...(completionFacts === undefined ? {} : { facts: completionFacts }),
      attempt: options.attempt,
      evidenceRef: options.evidenceRef,
      workSnapshotRef:
        options.evidenceRef === undefined
          ? undefined
          : {
              version: "content-blob-ref-v1",
              digest: options.evidenceRef,
              byteLength: 1,
              mediaType: "application/json",
            },
      attemptSnapshotRef:
        options.evidenceRef === undefined
          ? undefined
          : {
              version: "content-blob-ref-v1",
              digest: options.evidenceRef,
              byteLength: 1,
              mediaType: "application/json",
            },
      completionSnapshotRef:
        options.evidenceRef === undefined
          ? undefined
          : {
              version: "content-blob-ref-v1",
              digest: options.evidenceRef,
              byteLength: 1,
              mediaType: "application/json",
            },
    },
  } as Execution.KernelTransitionCommandV1;
}

const created = envelope("work.created.v1", "work-1", 1, digest("1"));

describe("work reducer and WI-01..17 guards", () => {
  test("rebuilds immutable evidence, blockers, retries, outcome, and terminal truth", () => {
    const evidence = digest("2");
    const blocker = digest("3");
    const events = [
      created,
      envelope("work.metadata_revised.v1", "work-1", 2, digest("4")),
      envelope("work.evidence_recorded.v1", "work-1", 3, evidence),
      envelope("work.evidence_recorded.v1", "work-1", 4, evidence),
      envelope("work.blocker_added.v1", "work-1", 5, blocker),
      envelope("work.blocker_resolved.v1", "work-1", 6, blocker),
      envelope("attempt.allocated.v1", "attempt-1", 7),
      envelope("attempt.start_requested.v1", "attempt-1", 8),
      envelope("attempt.failed.v1", "attempt-1", 9),
      envelope("work.outcome_recorded.v1", "work-1", 10, digest("5")),
      envelope("work.completed.v1", "work-1", 11),
    ];
    const projection = reduceWorkProjection("work-1", [...events].reverse());
    expect(projection).toMatchObject({
      status: "completed",
      evidenceRefs: [evidence],
      activeBlockerRefs: [],
      resolvedBlockerRefs: [blocker],
      attemptIds: ["attempt-1"],
      outcomeRef: digest("5"),
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  test("covers every work edge and rejects duplicate/invalid mutable facts", () => {
    const all = Array.from(
      { length: 17 },
      (_, index) => `WI-${String(index + 1).padStart(2, "0")}`,
    );
    for (const id of all) {
      const result = workAttemptCompletionGuardReason(command(id), id === "WI-01" ? [] : [created]);
      expect(result).not.toBe("unknown_family_edge");
    }
    expect(workAttemptCompletionGuardReason(command("WI-01"), [created])).toBe(
      "work_already_exists",
    );
    const evidence = digest("6");
    expect(
      workAttemptCompletionGuardReason(command("WI-06", { evidenceRef: evidence }), [
        created,
        envelope("work.evidence_recorded.v1", "work-1", 2, evidence),
      ]),
    ).toBe("duplicate_evidence");
    const blockerEvents = [created, envelope("work.blocker_added.v1", "work-1", 2, evidence)];
    expect(
      workAttemptCompletionGuardReason(command("WI-08", { evidenceRef: evidence }), blockerEvents),
    ).toBe("duplicate_active_blocker");
    expect(
      workAttemptCompletionGuardReason(command("WI-09", { evidenceRef: evidence }), blockerEvents),
    ).toBeNull();
    expect(
      workAttemptCompletionGuardReason(command("WI-15"), [
        created,
        envelope("attempt.allocated.v1", "attempt-1", 2),
      ]),
    ).toBe("active_attempt_exists");
  });

  test("requires terminal immutable lineage for retry and maps its allocation to the attempt", () => {
    const prior = attempt("attempt-1", 1);
    const next = attempt("attempt-2", 2);
    const terminal = [
      created,
      envelope("attempt.allocated.v1", prior.attemptId, 2),
      envelope("attempt.start_requested.v1", prior.attemptId, 3),
      envelope("attempt.failed.v1", prior.attemptId, 4),
    ];
    expect(
      workAttemptCompletionGuardReason(command("WI-12", { attempt: next }), terminal),
    ).toBeNull();
    expect(
      workAttemptCompletionGuardReason(
        command("WI-12", { attempt: attempt("attempt-2", 3) }),
        terminal,
      ),
    ).toBe("attempt_sequence_conflict");
    expect(
      workAttemptCompletionEventSubject(
        command("WI-12", { attempt: next }),
        "attempt.allocated.v1",
      ),
    ).toBe("attempt-2");
    expect(
      workAttemptCompletionEventSubject(command("WI-12", { attempt: next }), "work.started.v1"),
    ).toBe("work-1");
  });
});

describe("attempt reducer and AT-01..15 guards", () => {
  test("rebuilds contiguous lineage and effect-confirmed running state deterministically", () => {
    const events = [
      envelope("attempt.allocated.v1", "attempt-1", 2),
      envelope("attempt.start_requested.v1", "attempt-1", 3, digest("7")),
      envelope("effect.confirmed.v1", "attempt-1", 4, digest("8")),
      envelope("attempt.running.v1", "attempt-1", 5),
      envelope("attempt.failed.v1", "attempt-1", 6, digest("9")),
      envelope("attempt.allocated.v1", "attempt-2", 7),
    ];
    const states = reduceAttemptProjections([...events].reverse());
    expect(states.get("attempt-1")).toMatchObject({
      attemptSeq: 1,
      status: "failed",
      retryOfAttemptId: null,
    });
    expect(states.get("attempt-2")).toMatchObject({
      attemptSeq: 2,
      status: "allocated",
      retryOfAttemptId: "attempt-1",
    });
    expect(states.get("attempt-1")?.confirmedEffectRefs).toEqual([digest("8")]);
  });

  test("covers all attempt edges and keeps running impossible before effect intent confirmation", () => {
    const all = Array.from(
      { length: 15 },
      (_, index) => `AT-${String(index + 1).padStart(2, "0")}`,
    );
    for (const id of all) {
      const result = workAttemptCompletionGuardReason(
        command(id, { attempt: attempt("attempt-1", 1) }),
        [created],
      );
      expect(result).not.toBe("unknown_family_edge");
    }
    const starting = [
      created,
      envelope("attempt.allocated.v1", "attempt-1", 2),
      envelope("attempt.start_requested.v1", "attempt-1", 3),
    ];
    const confirm = command("AT-03", { attempt: attempt("attempt-1", 1) });
    expect(workAttemptCompletionGuardReason(confirm, starting)).toBe(
      "confirmed_effect_requires_intent",
    );
    expect(
      workAttemptCompletionGuardReason(confirm, [
        ...starting,
        envelope("effect.intent.v1", "attempt-1", 4),
      ]),
    ).toBeNull();
    expect(() =>
      reduceAttemptProjections([
        envelope("attempt.allocated.v1", "attempt-1", 1),
        envelope("attempt.running.v1", "attempt-1", 2),
      ]),
    ).toThrow("confirmation requires starting or waiting");
  });
});

describe("completion reducer and CP-01..04 guards", () => {
  test("freezes candidate stakes boundary and rebuilds exact ordered proof refs", () => {
    const candidate = envelope("completion.candidate.submitted.v1", "work-1", 2, digest("a"));
    const firstVerdict = envelope("completion.claim_verdict_recorded.v1", "work-1", 3, digest("b"));
    const rawSecondVerdict = envelope(
      "completion.claim_verdict_recorded.v1",
      "work-1",
      4,
      digest("e"),
    );
    const firstVerdictRef = firstVerdict.event.payload.verdictArtifactRef;
    const secondVerdictRef = rawSecondVerdict.event.payload.verdictArtifactRef;
    if (firstVerdictRef === null || secondVerdictRef === null) {
      throw new Error("verdict fixture requires artifact refs");
    }
    const secondVerdict = {
      ...rawSecondVerdict,
      event: {
        ...rawSecondVerdict.event,
        payload: {
          ...rawSecondVerdict.event.payload,
          verdictArtifactRefs: [firstVerdictRef, secondVerdictRef],
        },
      },
    } as Ledger.EnvelopeV1;
    const rawDecision = envelope("completion.decision_recorded.v1", "work-1", 5, digest("c"));
    const decision = {
      ...rawDecision,
      event: {
        ...rawDecision.event,
        payload: {
          ...rawDecision.event.payload,
          verdictArtifactRefs: secondVerdict.event.payload.verdictArtifactRefs,
        },
      },
    } as Ledger.EnvelopeV1;
    const projection = reduceCompletionProjection("work-1", [
      decision,
      secondVerdict,
      candidate,
      firstVerdict,
    ]);
    expect(projection).toMatchObject({
      status: "admitted",
      candidateRef: digest("a"),
      verdictRefs: [digest("b"), digest("e")],
      decisionRef: digest("c"),
      stakesAsOfLedgerSeq: 2,
      stakesAsOfDbMs: 1_002,
    });
    expect(candidate.event.payload.candidateArtifactRef?.digest).not.toBe(
      candidate.event.payload.completionSnapshotRef?.digest,
    );
    expect(firstVerdict.event.payload.verdictArtifactRef?.digest).not.toBe(
      firstVerdict.event.payload.completionSnapshotRef?.digest,
    );
    expect(decision.event.payload.admissionDecisionArtifactRef?.digest).not.toBe(
      decision.event.payload.completionSnapshotRef?.digest,
    );

    const wrongCoverage = {
      ...firstVerdict,
      event: {
        ...firstVerdict.event,
        payload: { ...firstVerdict.event.payload, verdictArtifactRefs: [completionRef("e")] },
      },
    } as Ledger.EnvelopeV1;
    expect(() => reduceCompletionProjection("work-1", [candidate, wrongCoverage])).toThrow(
      "verdict coverage is not exact and ordered",
    );
    const duplicateVerdict = {
      ...secondVerdict,
      event: {
        ...secondVerdict.event,
        payload: {
          ...secondVerdict.event.payload,
          verdictArtifactRef: completionRef("b"),
          verdictArtifactRefs: [completionRef("b"), completionRef("b")],
        },
      },
    } as Ledger.EnvelopeV1;
    expect(() =>
      reduceCompletionProjection("work-1", [candidate, firstVerdict, duplicateVerdict]),
    ).toThrow("duplicate terminal claim verdict");
    const reorderedDecision = {
      ...decision,
      event: {
        ...decision.event,
        payload: {
          ...decision.event.payload,
          verdictArtifactRefs: [completionRef("e"), completionRef("b")],
        },
      },
    } as Ledger.EnvelopeV1;
    expect(() =>
      reduceCompletionProjection("work-1", [
        candidate,
        firstVerdict,
        secondVerdict,
        reorderedDecision,
      ]),
    ).toThrow("admission verdict coverage is not exact");
  });

  test("covers CP-01..04 and requires candidate, unique verdict, coverage, and no blocker", () => {
    const allocation = envelope("attempt.allocated.v1", "attempt-1", 2, digest("8"));
    const candidate = envelope("completion.candidate.submitted.v1", "work-1", 3, digest("a"));
    const verdict = envelope("completion.claim_verdict_recorded.v1", "work-1", 4, digest("b"));
    for (const id of ["CP-01", "CP-02", "CP-03", "CP-04"]) {
      expect(workAttemptCompletionGuardReason(command(id), [created, allocation])).not.toBe(
        "unknown_family_edge",
      );
    }
    expect(
      workAttemptCompletionGuardReason(command("CP-01"), [created, allocation, candidate]),
    ).toBe("candidate_immutable");
    expect(
      workAttemptCompletionGuardReason(command("CP-04"), [created, allocation, candidate]),
    ).toBe("complete_verdict_coverage_required");
    expect(
      workAttemptCompletionGuardReason(command("CP-04"), [created, allocation, candidate, verdict]),
    ).toBeNull();
    expect(
      workAttemptCompletionGuardReason(command("CP-04"), [
        created,
        allocation,
        envelope("work.blocker_added.v1", "work-1", 3, digest("e")),
        envelope("completion.candidate.submitted.v1", "work-1", 4, digest("a")),
        envelope("completion.claim_verdict_recorded.v1", "work-1", 5, digest("b")),
      ]),
    ).toBe("active_blockers_prevent_completion");
    expect(() => reduceCompletionProjection("work-1", [candidate, candidate])).toThrow(
      "candidate is immutable",
    );
  });
});
