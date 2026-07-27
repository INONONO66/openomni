import { describe, expect, test } from "bun:test";
import type { Ledger } from "@openomni/protocol";
import { assertEffectMayAct, reduceEffect } from "../../src/ledger/reducers/effect.js";
import { reduceGrant, reduceSchedule } from "../../src/ledger/reducers/grant-schedule.js";
import {
  assertEffectTransition,
  assertGrantTransition,
  assertScheduleTransition,
} from "../../src/ledger/transitions/grant-schedule-effect.js";
import type { KernelTransitionCommandV1 } from "../../src/ledger/ports.js";

const owner = { version: "ledger-owner-v1", ownerKey: "owner:1" } as const;
const refA = "a".repeat(64);
const refB = "b".repeat(64);
const identity = {
  version: "authenticated-worker-identity-v1",
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 1,
  principalId: "owner-principal",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
} as const;

function history(
  rows: readonly { type: Ledger.NativeEventTypeV1; subject: string; ref?: string }[],
): Ledger.EnvelopeV1[] {
  let previous: "GENESIS_V1" | string = "GENESIS_V1";
  return rows.map((row, index) => {
    const eventHash = String(index + 1)
      .repeat(64)
      .slice(0, 64);
    const envelope = {
      version: "ledger-envelope-v1",
      envelopeVersion: 1,
      ledgerSeq: index + 1,
      ownerSeq: index + 1,
      previousEventHash: previous,
      eventHash,
      event: {
        version: "ledger-event-v1",
        eventId: `event-${index + 1}`,
        eventType: row.type,
        eventVersion: 1,
        owner,
        payload: {
          version: "native-event-payload-v1",
          eventType: row.type,
          subjectId: row.subject,
          occurredAtDbMs: index + 1,
          ...(row.type.startsWith("grant.")
            ? {
                grantId: row.subject,
                workItemId: "work-1",
                attemptId: "attempt-1",
                granteeId: "actor-1",
                grantScopeRef: {
                  version: "content-blob-ref-v1",
                  digest: refA,
                  byteLength: 1,
                  mediaType: "application/json",
                },
                grantSnapshotRef: {
                  version: "content-blob-ref-v1",
                  digest: row.ref ?? refA,
                  byteLength: 1,
                  mediaType: "application/json",
                },
              }
            : {}),
          ...(row.type.startsWith("schedule.")
            ? {
                scheduleId: row.subject,
                generation: index + 1,
                nextFireRef: row.ref ?? null,
                settlementRef: row.type === "schedule.fire_settled.v1" ? refB : null,
                scheduleSnapshotRef: {
                  version: "content-blob-ref-v1",
                  digest: refA,
                  byteLength: 1,
                  mediaType: "application/json",
                },
              }
            : {}),
          ...(row.type.startsWith("effect.")
            ? {
                effectId: row.subject,
                idempotencyKey: row.ref ?? refA,
                workItemId: "work-1",
                attemptId: "attempt-1",
                effectScopeRef: {
                  version: "content-blob-ref-v1",
                  digest: refA,
                  byteLength: 1,
                  mediaType: "application/json",
                },
                settlement:
                  row.type === "effect.unknown.v1"
                    ? "unknown"
                    : row.type === "effect.definite_failed.v1"
                      ? "definite_failed"
                      : row.type === "effect.manually_resolved.v1"
                        ? "manually_resolved"
                        : "confirmed",
                effectSettlementRef: {
                  version: "content-blob-ref-v1",
                  digest: refB,
                  byteLength: 1,
                  mediaType: "application/json",
                },
              }
            : {}),
        },
        provenance: {
          version: "native-event-provenance-v1",
          principalId: "principal-1",
          requestId: `request-${index + 1}`,
        },
      },
      batch: {
        version: "ledger-batch-position-v1",
        batchId: `batch-${index + 1}`,
        index: 0,
        size: 1,
      },
      requestId: `request-${index + 1}`,
      requestHash: refA,
      principalId: "principal-1",
      committedAtDbMs: index + 1,
    } as Ledger.EnvelopeV1;
    previous = eventHash;
    return envelope;
  });
}

function command(
  transitionId: string,
  commandName: string,
  subjectId: string,
  events: readonly Ledger.EnvelopeV1[],
  evidenceRef: string | null = refA,
): KernelTransitionCommandV1 {
  return {
    version: "kernel-transition-command-v1",
    transitionId,
    command: commandName,
    requestId: `command-${transitionId}`,
    requestHash: refB,
    identity,
    expectedHead: {
      version: "ledger-head-v1",
      owner,
      ownerSeq: events.length,
      eventHash: events.at(-1)?.eventHash ?? "GENESIS_V1",
    },
    payload: {
      version: "native-transition-payload-v1",
      transitionId,
      command: commandName,
      owner,
      subjectId,
      attempt: {
        version: "attempt-ref-v1",
        workItemId: "work-1",
        attemptId: "attempt-1",
        attemptSeq: 1,
      },
      ...(evidenceRef === null ? {} : { evidenceRef }),
      grantId: subjectId,
      scheduleId: subjectId,
      nextFireRef: evidenceRef,
      settlementRef: refB,
      effect: {
        version: "effect-ref-v1",
        effectId: subjectId,
        idempotencyKey: evidenceRef ?? refA,
      },
    },
  } as KernelTransitionCommandV1;
}

describe("grant transitions and reducer", () => {
  test("implements GR-01..04 with monotonic versions and exact Attempt source refs", () => {
    const empty: Ledger.EnvelopeV1[] = [];
    expect(() =>
      assertGrantTransition(command("GR-01", "kernel.grant.create.v1", "grant-1", empty), empty),
    ).not.toThrow();

    const created = history([{ type: "grant.created.v1", subject: "grant-1", ref: refA }]);
    expect(reduceGrant(created)).toMatchObject({
      version: 1,
      status: "active",
      attemptSourceRef: "attempt-1",
    });
    expect(() =>
      assertGrantTransition(
        command("GR-04", "kernel.grant.revise.v1", "grant-1", created),
        created,
      ),
    ).not.toThrow();
    expect(() =>
      assertGrantTransition(
        command("GR-02", "kernel.grant.revoke.v1", "grant-1", created),
        created,
      ),
    ).not.toThrow();
    expect(() =>
      assertGrantTransition(
        command("GR-03", "kernel.grant.expire.v1", "grant-1", created),
        created,
      ),
    ).not.toThrow();

    const revised = history([
      { type: "grant.created.v1", subject: "grant-1", ref: refA },
      { type: "grant.revised.v1", subject: "grant-1", ref: refA },
    ]);
    expect(reduceGrant(revised)).toMatchObject({ version: 2, status: "active" });
    const mismatched = command("GR-04", "kernel.grant.revise.v1", "grant-1", created);
    expect(() =>
      assertGrantTransition(
        {
          ...mismatched,
          payload: {
            ...mismatched.payload,
            attempt: {
              version: "attempt-ref-v1",
              workItemId: "work-1",
              attemptId: "attempt-2",
              attemptSeq: 2,
            },
          },
        },
        created,
      ),
    ).toThrow("source ref mismatch");
  });

  test("makes revoke and expiry terminal", () => {
    const revoked = history([
      { type: "grant.created.v1", subject: "grant-1", ref: refA },
      { type: "grant.revoked.v1", subject: "grant-1", ref: refA },
    ]);
    expect(reduceGrant(revoked)?.status).toBe("revoked");
    expect(() =>
      assertGrantTransition(
        command("GR-04", "kernel.grant.revise.v1", "grant-1", revoked),
        revoked,
      ),
    ).toThrow("grant is revoked");
  });
});

describe("schedule transitions and reducer", () => {
  test("implements deterministic SC-01 generation advances", () => {
    const empty: Ledger.EnvelopeV1[] = [];
    expect(() =>
      assertScheduleTransition(
        command("SC-01", "kernel.schedule.initialize_or_advance.v1", "schedule-1", empty),
        empty,
      ),
    ).not.toThrow();
    const advanced = history([{ type: "schedule.advanced.v1", subject: "schedule-1", ref: refA }]);
    expect(reduceSchedule(advanced)).toMatchObject({
      generation: 1,
      nextFireRef: refA,
      pendingFire: null,
    });
    expect(() =>
      assertScheduleTransition(
        command("SC-01", "kernel.schedule.initialize_or_advance.v1", "schedule-1", advanced, null),
        advanced,
      ),
    ).toThrow("missing payload.nextFireRef");
  });

  test("SC-02 settles only a confirmed or definitely-failed recorded fire effect", () => {
    const base = [
      { type: "schedule.advanced.v1", subject: "schedule-1", ref: refA },
      { type: "schedule.fire_due.v1", subject: "schedule-1", ref: refA },
      { type: "effect.intent.v1", subject: "effect-1", ref: refA },
    ] as const;
    const pending = history(base);
    expect(() =>
      assertScheduleTransition(
        command("SC-02", "kernel.schedule.settle_and_advance.v1", "schedule-1", pending),
        pending,
      ),
    ).toThrow("effect is pending");
    const unknown = history([
      ...base,
      { type: "effect.unknown.v1", subject: "effect-1", ref: refA },
    ]);
    expect(() =>
      assertScheduleTransition(
        command("SC-02", "kernel.schedule.settle_and_advance.v1", "schedule-1", unknown),
        unknown,
      ),
    ).toThrow("effect is unknown");
    for (const type of ["effect.confirmed.v1", "effect.definite_failed.v1"] as const) {
      const settled = history([...base, { type, subject: "effect-1", ref: refA }]);
      expect(() =>
        assertScheduleTransition(
          command("SC-02", "kernel.schedule.settle_and_advance.v1", "schedule-1", settled),
          settled,
        ),
      ).not.toThrow();
    }
  });
});

describe("effect transitions and reducer", () => {
  test("implements EF-01..03 only from pending intent with exact idempotency ref", () => {
    const intent = history([{ type: "effect.intent.v1", subject: "effect-1", ref: refA }]);
    expect(reduceEffect(intent)).toMatchObject({ status: "pending", idempotencyRef: refA });
    for (const [id, name] of [
      ["EF-01", "kernel.effect.confirm.v1"],
      ["EF-02", "kernel.effect.fail_definite.v1"],
      ["EF-03", "kernel.effect.mark_unknown.v1"],
    ] as const) {
      expect(() =>
        assertEffectTransition(command(id, name, "effect-1", intent), intent),
      ).not.toThrow();
    }
    expect(() =>
      assertEffectTransition(
        command("EF-01", "kernel.effect.confirm.v1", "effect-1", [], refA),
        [],
      ),
    ).toThrow("record-before-act intent");
    expect(() =>
      assertEffectTransition(
        command("EF-01", "kernel.effect.confirm.v1", "effect-1", intent, refB),
        intent,
      ),
    ).toThrow("source ref mismatch");
  });

  test("denies action while unknown and retains unknown history through EF-04", () => {
    const unknown = history([
      { type: "effect.intent.v1", subject: "effect-1", ref: refA },
      { type: "effect.unknown.v1", subject: "effect-1", ref: refA },
    ]);
    const unknownState = reduceEffect(unknown);
    expect(() => assertEffectMayAct(unknownState)).toThrow("effect is unknown");
    expect(() =>
      assertEffectTransition(
        command("EF-04", "kernel.effect.resolve_unknown.v1", "effect-1", unknown),
        unknown,
      ),
    ).not.toThrow();

    const resolved = history([
      { type: "effect.intent.v1", subject: "effect-1", ref: refA },
      { type: "effect.unknown.v1", subject: "effect-1", ref: refA },
      { type: "effect.manually_resolved.v1", subject: "effect-1", ref: refA },
    ]);
    expect(reduceEffect(resolved)).toMatchObject({
      status: "manually_resolved",
      intentEventId: "event-1",
      unknownEventId: "event-2",
      settlementEventId: "event-3",
    });
    expect(() => assertEffectMayAct(reduceEffect(resolved))).toThrow("manually_resolved");
  });
});
