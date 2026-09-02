import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../../src/json.js";
import { Trigger } from "../../src/trigger/index.js";
import {
  buildBatch,
  buildCommandRecord,
  buildEveryRecord,
  buildFileRecord,
  buildFire,
  buildOnceRecord,
  buildReservation,
  buildScheduleMarker,
  buildTerminalBatch,
  CREATED_AT,
  fingerprintOf,
  OWNER,
  required,
} from "../helpers/trigger.js";

describe("Trigger.Source — locked source vocabulary", () => {
  test("all four kinds parse and no fifth kind is admitted", () => {
    expect(Trigger.Kinds).toEqual(["time.once", "time.every", "event.command", "event.file"]);
    expect(Trigger.Source.parse({ kind: "time.once", at: CREATED_AT }).kind).toBe("time.once");
    expect(Trigger.Source.parse({ kind: "time.every", intervalMs: 60_000 }).kind).toBe(
      "time.every",
    );
    expect(
      Trigger.Source.parse({ kind: "event.command", command: "ls", persistent: false }).kind,
    ).toBe("event.command");
    expect(Trigger.Source.parse({ kind: "event.file", path: "/tmp/x", on: "modify" }).kind).toBe(
      "event.file",
    );
    expect(Trigger.Source.safeParse({ kind: "event.webhook", url: "x" }).success).toBe(false);
  });

  test("unknown fields are rejected on every branch", () => {
    expect(Trigger.Source.safeParse({ kind: "time.once", at: CREATED_AT, tz: "UTC" }).success).toBe(
      false,
    );
    expect(
      Trigger.Source.safeParse({
        kind: "event.command",
        command: "ls",
        persistent: false,
        shell: "/bin/zsh",
      }).success,
    ).toBe(false);
  });

  test("stored command rejects NUL and an invalid regex", () => {
    const nul = Trigger.Source.safeParse({
      kind: "event.command",
      command: "echo \u0000hi",
      persistent: true,
    });
    expect(nul.success).toBe(false);
    expect(nul.error?.issues[0]?.message).toBe("command contains NUL");

    const badFilter = Trigger.Source.safeParse({
      kind: "event.command",
      command: "ls",
      filter: "(unclosed",
      persistent: false,
    });
    expect(badFilter.success).toBe(false);
    expect(badFilter.error?.issues[0]?.message).toBe("invalid regular expression");

    expect(
      Trigger.Source.safeParse({
        kind: "event.command",
        command: "ls",
        filter: "^ERROR",
        persistent: false,
      }).success,
    ).toBe(true);
  });

  test("stored persistent is required while the create input defaults it", () => {
    expect(Trigger.Source.safeParse({ kind: "event.command", command: "ls" }).success).toBe(false);
    const created = Trigger.CreateSource.parse({ kind: "event.command", command: "ls" });
    expect(created).toEqual({ kind: "event.command", command: "ls", persistent: false });
    expect(Trigger.CreateSource.parse({ kind: "event.file", path: "/tmp/x" })).toEqual({
      kind: "event.file",
      path: "/tmp/x",
      on: "create",
    });
  });

  test("create input applies the same command refinements", () => {
    expect(
      Trigger.CreateSource.safeParse({ kind: "event.command", command: "ls", filter: "([" })
        .success,
    ).toBe(false);
    expect(
      Trigger.CreateSource.safeParse({ kind: "event.command", command: "a\u0000b" }).success,
    ).toBe(false);
  });

  test("bounded string limits are enforced", () => {
    const tooLong = "x".repeat(Trigger.Constants.MAX_COMMAND_CHARS + 1);
    expect(
      Trigger.Source.safeParse({ kind: "event.command", command: tooLong, persistent: false })
        .success,
    ).toBe(false);
    expect(
      Trigger.Source.safeParse({
        kind: "event.file",
        path: "x".repeat(Trigger.Constants.MAX_PATH_CHARS + 1),
        on: "create",
      }).success,
    ).toBe(false);
  });
});

describe("Trigger.Record — scheduling projection refinement", () => {
  test("time.once carries no recurring or expiry fields", () => {
    expect(buildOnceRecord().source.kind).toBe("time.once");
    expect(
      Trigger.Record.safeParse({
        ...buildOnceRecord(),
        expiresAt: CREATED_AT + 1_000,
      }).success,
    ).toBe(false);
    expect(
      Trigger.Record.safeParse({ ...buildOnceRecord(), nextFireAt: CREATED_AT + 1 }).success,
    ).toBe(false);
  });

  test("time.every requires agreeing interval projections and a legal next fire", () => {
    const record = buildEveryRecord();
    expect(record.effectiveIntervalMs).toBe(Trigger.Constants.MIN_RECURRING_INTERVAL_MS);

    // Indexed projection may never drift from the stored source interval.
    expect(Trigger.Record.safeParse({ ...record, effectiveIntervalMs: 120_000 }).success).toBe(
      false,
    );
    // Below the minimum recurring interval.
    expect(
      Trigger.Record.safeParse({
        ...record,
        source: { kind: "time.every", intervalMs: 30_000 },
        effectiveIntervalMs: 30_000,
        requestedIntervalMs: 30_000,
      }).success,
    ).toBe(false);
    // Next fire past the absolute expiry.
    expect(
      Trigger.Record.safeParse({
        ...record,
        nextFireAt: required(record.expiresAt, "expiresAt") + 1,
      }).success,
    ).toBe(false);
    // Missing schedule entirely.
    expect(Trigger.Record.safeParse({ ...record, nextFireAt: undefined }).success).toBe(false);
  });

  test("finite command has an expiry and a persistent command has none", () => {
    expect(buildCommandRecord().expiresAt).toBe(CREATED_AT + Trigger.Constants.SOURCE_TIMEOUT_MS);
    const persistent = Trigger.Record.safeParse({
      ...buildCommandRecord(),
      source: { kind: "event.command", command: "tail -f build.log", persistent: true },
      expiresAt: undefined,
    });
    expect(persistent.success).toBe(true);
    expect(
      Trigger.Record.safeParse({
        ...buildCommandRecord(),
        source: { kind: "event.command", command: "tail -f build.log", persistent: true },
      }).success,
    ).toBe(false);
    expect(
      Trigger.Record.safeParse({ ...buildCommandRecord(), expiresAt: undefined }).success,
    ).toBe(false);
  });

  test("event.file always carries a finite expiry and no schedule", () => {
    expect(buildFileRecord().expiresAt).toBe(CREATED_AT + Trigger.Constants.SOURCE_TIMEOUT_MS);
    expect(Trigger.Record.safeParse({ ...buildFileRecord(), expiresAt: undefined }).success).toBe(
      false,
    );
    expect(
      Trigger.Record.safeParse({ ...buildFileRecord(), nextFireAt: CREATED_AT + 5 }).success,
    ).toBe(false);
  });

  test("lastObservedAt is required and cannot precede creation", () => {
    const { lastObservedAt: _dropped, ...withoutWatermark } = buildOnceRecord();
    expect(Trigger.Record.safeParse(withoutWatermark).success).toBe(false);
    expect(
      Trigger.Record.safeParse({ ...buildOnceRecord(), lastObservedAt: CREATED_AT - 1 }).success,
    ).toBe(false);
    expect(
      Trigger.Record.safeParse({ ...buildOnceRecord(), updatedAt: CREATED_AT - 1 }).success,
    ).toBe(false);
  });

  test("updatedAt cannot precede the observation watermark", () => {
    expect(
      Trigger.Record.safeParse({
        ...buildOnceRecord(),
        lastObservedAt: CREATED_AT + 10,
        updatedAt: CREATED_AT + 5,
      }).success,
    ).toBe(false);
  });

  test("the pending flag and the pending batch agree, and pending needs a Fire gate", () => {
    const batch = buildBatch();
    expect(
      Trigger.Record.safeParse({ ...buildCommandRecord(), coalescedFirePending: true }).success,
    ).toBe(false);
    expect(
      Trigger.Record.safeParse({
        ...buildCommandRecord(),
        pendingBatch: batch,
        coalescedFirePending: false,
      }).success,
    ).toBe(false);
    expect(
      Trigger.Record.safeParse({
        ...buildCommandRecord(),
        pendingBatch: batch,
        coalescedFirePending: true,
      }).success,
    ).toBe(false);
    expect(
      Trigger.Record.safeParse({
        ...buildCommandRecord(),
        inFlightFireId: "fire-1",
        pendingBatch: batch,
        coalescedFirePending: true,
      }).success,
    ).toBe(true);
  });

  test("an ended Trigger keeps only a terminal or schedule-marker pending batch", () => {
    const ended = {
      ...buildCommandRecord(),
      lifecycle: {
        state: "ended" as const,
        endReason: "source_exited" as const,
        endedAt: CREATED_AT + 5,
      },
      inFlightFireId: "fire-1",
      coalescedFirePending: true,
    };
    expect(Trigger.Record.safeParse({ ...ended, pendingBatch: buildBatch() }).success).toBe(false);
    expect(
      Trigger.Record.safeParse({
        ...ended,
        pendingBatch: buildTerminalBatch("source_exited", CREATED_AT + 5),
      }).success,
    ).toBe(true);
  });

  test("terminal detail is bounded and terminal fields never appear on live states", () => {
    const detail = "x".repeat(Trigger.Constants.MAX_DETAIL_CHARS + 1);
    expect(
      Trigger.Record.safeParse({
        ...buildOnceRecord(),
        lifecycle: {
          state: "ended",
          endReason: "source_error",
          endedAt: CREATED_AT,
          endDetail: detail,
        },
      }).success,
    ).toBe(false);
    expect(Trigger.Lifecycle.safeParse({ state: "armed", endReason: "cancelled" }).success).toBe(
      false,
    );
    expect(Trigger.Lifecycle.safeParse({ state: "paused" }).success).toBe(false);
  });
});

type BatchFacts = Omit<Trigger.PendingBatch, "fingerprint">;

function batchFacts(): BatchFacts {
  return {
    items: [{ kind: "line", text: "build started", at: CREATED_AT }],
    overflowCount: 0,
    scheduleMarker: false,
    firstAt: CREATED_AT,
    lastAt: CREATED_AT,
  };
}

function parseFacts(facts: BatchFacts) {
  return Trigger.PendingBatch.safeParse({ ...facts, fingerprint: fingerprintOf(facts) });
}

describe("Trigger.PendingBatch — bounded coalescing", () => {
  test("fingerprint mismatch is refused rather than recomputed", () => {
    const batch = buildBatch();
    expect(
      Trigger.PendingBatch.safeParse({ ...batch, fingerprint: canonicalDigest("other") }).success,
    ).toBe(false);
    // Changing a covered fact without recomputing the fingerprint is corrupt.
    expect(Trigger.PendingBatch.safeParse({ ...batch, overflowCount: 3 }).success).toBe(false);
    expect(parseFacts({ ...batchFacts(), overflowCount: 3 }).success).toBe(true);
  });

  test("a schedule marker is empty, non-terminal, and carries a scheduled instant", () => {
    const marker = buildScheduleMarker(CREATED_AT + 60_000, CREATED_AT + 61_000);
    expect(marker.scheduleMarker).toBe(true);
    expect(marker.items).toHaveLength(0);

    const { fingerprint: _pinned, ...facts } = marker;
    for (const broken of [
      { items: [{ kind: "line" as const, text: "x", at: CREATED_AT + 61_000 }] },
      { overflowCount: 1 },
      { scheduledForAt: undefined },
      { terminalReason: "cancelled" as const },
    ]) {
      expect(parseFacts({ ...facts, ...broken }).success).toBe(false);
    }
  });

  test("a source batch has no schedule instant and is non-empty unless it discloses overflow", () => {
    expect(parseFacts({ ...batchFacts(), scheduledForAt: CREATED_AT }).success).toBe(false);
    expect(parseFacts({ ...batchFacts(), items: [] }).success).toBe(false);
    expect(buildBatch({ items: [], overflowCount: 4 }).overflowCount).toBe(4);
  });

  test("terminal reason requires exactly one summary item", () => {
    expect(parseFacts({ ...batchFacts(), terminalReason: "cancelled" }).success).toBe(false);
    expect(
      parseFacts({
        ...batchFacts(),
        items: [{ kind: "summary", text: "done", at: CREATED_AT }],
      }).success,
    ).toBe(false);
    expect(
      parseFacts({
        ...batchFacts(),
        items: [
          { kind: "summary", text: "one", at: CREATED_AT },
          { kind: "summary", text: "two", at: CREATED_AT },
        ],
        terminalReason: "source_exited",
      }).success,
    ).toBe(false);
  });

  test("item timestamps stay inside the batch window", () => {
    expect(
      parseFacts({
        ...batchFacts(),
        items: [{ kind: "line", text: "late", at: CREATED_AT + 10 }],
      }).success,
    ).toBe(false);
    expect(
      parseFacts({ ...batchFacts(), items: [], firstAt: CREATED_AT + 10, lastAt: CREATED_AT })
        .success,
    ).toBe(false);
  });

  test("the rendered budget bounds items, labels, and separators", () => {
    const budget = Trigger.Constants.NOTIFIER_MAX_CHARS - Trigger.Constants.QUEUE_OVERHEAD_CHARS;
    const text = "y".repeat(Trigger.Constants.MAX_EVENT_TEXT_CHARS);
    const perItem = "line".length + text.length + 4;
    const fits = Math.floor(budget / perItem);
    const build = (count: number) =>
      parseFacts({
        ...batchFacts(),
        items: Array.from({ length: count }, () => ({
          kind: "line" as const,
          text,
          at: CREATED_AT,
        })),
      });
    expect(build(fits).success).toBe(true);
    expect(build(fits + 1).success).toBe(false);
  });

  test("item count never exceeds the notifier line limit", () => {
    expect(
      parseFacts({
        ...batchFacts(),
        items: Array.from({ length: Trigger.Constants.NOTIFIER_MAX_LINES + 1 }, () => ({
          kind: "line" as const,
          text: "x",
          at: CREATED_AT,
        })),
      }).success,
    ).toBe(false);
  });
});

describe("Trigger.Fire — payload, cause, and status receipts", () => {
  test("payload digest must be the canonical digest of the payload", () => {
    expect(
      Trigger.Fire.safeParse({ ...buildFire(), payloadDigest: canonicalDigest("different") })
        .success,
    ).toBe(false);
    expect(Trigger.CanonicalDigest.safeParse("sha256:zz").success).toBe(false);
    expect(Trigger.CanonicalDigest.safeParse(canonicalDigest("x")).success).toBe(true);
  });

  test("payload is bounded to prompt + notifier block + envelope", () => {
    const budget: number =
      Trigger.Constants.MAX_PROMPT_CHARS +
      Trigger.Constants.NOTIFIER_MAX_CHARS +
      Trigger.Constants.FIRE_ENVELOPE_CHARS;
    expect(budget).toBe(Trigger.Constants.MAX_FIRE_PAYLOAD_CHARS);
    const oversize = "z".repeat(Trigger.Constants.MAX_FIRE_PAYLOAD_CHARS + 1);
    expect(
      Trigger.Fire.safeParse({
        ...buildFire(),
        payload: oversize,
        payloadDigest: canonicalDigest(oversize),
      }).success,
    ).toBe(false);
  });

  test("alarm and recovery causes carry a schedule and no source items", () => {
    const alarm = buildFire({
      cause: "alarm",
      sourceItems: [],
      scheduledForAt: CREATED_AT,
      triggerId: "trigger-every",
    });
    expect(alarm.cause).toBe("alarm");
    expect(Trigger.Fire.safeParse({ ...alarm, scheduledForAt: undefined }).success).toBe(false);
    expect(
      Trigger.Fire.safeParse({
        ...alarm,
        sourceItems: [{ kind: "line", text: "x", at: CREATED_AT }],
      }).success,
    ).toBe(false);
  });

  test("source_line refuses a summary and source_summary requires one", () => {
    expect(
      Trigger.Fire.safeParse({
        ...buildFire(),
        sourceItems: [{ kind: "summary", text: "done", at: CREATED_AT }],
      }).success,
    ).toBe(false);
    expect(Trigger.Fire.safeParse({ ...buildFire(), cause: "source_summary" }).success).toBe(false);
    expect(
      Trigger.Fire.safeParse({
        ...buildFire(),
        cause: "source_summary",
        terminalReason: "source_exited",
        sourceItems: [{ kind: "summary", text: "exit 0", at: CREATED_AT }],
      }).success,
    ).toBe(true);
  });

  test("a terminal reason needs a summary except for a completed once alarm", () => {
    expect(Trigger.Fire.safeParse({ ...buildFire(), terminalReason: "cancelled" }).success).toBe(
      false,
    );
    expect(
      Trigger.Fire.safeParse({
        ...buildFire(),
        cause: "alarm",
        sourceItems: [],
        scheduledForAt: CREATED_AT,
        terminalReason: "completed",
      }).success,
    ).toBe(true);
  });

  test("schedule cannot follow firing and firing cannot follow recording", () => {
    expect(
      Trigger.Fire.safeParse({
        ...buildFire({ cause: "alarm", sourceItems: [], scheduledForAt: CREATED_AT }),
        scheduledForAt: CREATED_AT + 1,
      }).success,
    ).toBe(false);
    expect(Trigger.Fire.safeParse({ ...buildFire(), recordedAt: CREATED_AT - 1 }).success).toBe(
      false,
    );
  });

  test("status receipts are required in order", () => {
    expect(Trigger.Fire.safeParse({ ...buildFire(), deliveredAt: CREATED_AT }).success).toBe(false);
    expect(Trigger.Fire.safeParse({ ...buildFire(), status: "delivered" }).success).toBe(false);

    const delivered = buildFire({
      status: "delivered",
      deliveredAt: CREATED_AT + 5,
      updatedAt: CREATED_AT + 5,
      deliveryAttempts: 1,
    });
    expect(delivered.status).toBe("delivered");
    expect(Trigger.Fire.safeParse({ ...delivered, ackedAt: CREATED_AT + 6 }).success).toBe(false);
    expect(Trigger.Fire.safeParse({ ...delivered, status: "acked" }).success).toBe(false);
  });

  test("acked requires an admission that pins fire, owner, and digest", () => {
    const base = buildFire({
      status: "delivered",
      deliveredAt: CREATED_AT + 5,
      updatedAt: CREATED_AT + 5,
      deliveryAttempts: 1,
    });
    const admission = {
      fireId: base.id,
      sessionId: OWNER,
      messageId: `trigger-fire:${base.id}`,
      payloadDigest: base.payloadDigest,
      admittedAt: CREATED_AT + 6,
    };
    const acked = Trigger.Fire.parse({
      ...base,
      status: "acked",
      admission,
      ackedAt: CREATED_AT + 7,
      updatedAt: CREATED_AT + 7,
    });
    expect(acked.admission?.messageId).toBe(`trigger-fire:${base.id}`);

    for (const bad of [
      { ...admission, fireId: "other-fire" },
      { ...admission, sessionId: "other-session" },
      { ...admission, payloadDigest: canonicalDigest("nope") },
      { ...admission, admittedAt: CREATED_AT + 4 },
    ]) {
      expect(Trigger.Fire.safeParse({ ...acked, admission: bad }).success).toBe(false);
    }
    expect(Trigger.Fire.safeParse({ ...acked, ackedAt: CREATED_AT + 5 }).success).toBe(false);
  });

  test("a reservation validates the same payload and cause rules", () => {
    expect(buildReservation().cause).toBe("source_line");
    expect(
      Trigger.FireReservation.safeParse({
        ...buildReservation(),
        payloadDigest: canonicalDigest("stale"),
      }).success,
    ).toBe(false);
  });
});

describe("Trigger events and typed errors", () => {
  test("bus descriptors name the parent and child revisions distinctly", () => {
    const created = Trigger.Events.Created.schema.parse({
      traceId: "trace-1",
      time: CREATED_AT,
      triggerId: "trigger-1",
      ownerSessionId: OWNER,
      kind: "time.once",
      triggerRevision: 1,
    });
    expect(created.triggerRevision).toBe(1);
    expect(Trigger.Events.Created.name).toBe("trigger.created");
    expect(Trigger.Events.FireRecorded.visibility).toBe("internal");

    const acked = Trigger.Events.FireAcked.schema.parse({
      traceId: "trace-1",
      time: CREATED_AT,
      triggerId: "trigger-1",
      fireId: "fire-1",
      fireRevision: 3,
      sessionId: OWNER,
      messageId: "trigger-fire:fire-1",
    });
    expect(acked.fireRevision).toBe(3);
    expect(
      Trigger.Events.FireAcked.schema.safeParse({
        traceId: "trace-1",
        time: CREATED_AT,
        triggerId: "trigger-1",
        fireId: "fire-1",
        revision: 3,
        sessionId: OWNER,
        messageId: "m",
      }).success,
    ).toBe(false);
  });

  test("pause and end reasons are the closed durable vocabularies", () => {
    expect(Trigger.PauseReason.options).toEqual([
      "wake_budget",
      "source_unavailable",
      "owner_session_missing",
      "recovery_conflict",
    ]);
    expect(Trigger.EndReason.options).toEqual([
      "cancelled",
      "completed",
      "expired",
      "source_exited",
      "source_timeout",
      "source_error",
    ]);
    expect(Trigger.TerminalFireReason.options).not.toContain("expired");
  });

  test("store errors carry a stable code and optional identity", () => {
    const error = new Trigger.StoreError({
      code: "revision_conflict",
      message: "stale",
      triggerId: "trigger-1",
    });
    expect(error.data.code).toBe("revision_conflict");
    expect(error.data.triggerId).toBe("trigger-1");
    expect(error.message).toBe("stale");
    expect(Trigger.StoreError.isInstance(error)).toBe(true);
    expect(Trigger.StoreErrorCode.safeParse("already_delivered").success).toBe(false);
    expect(Trigger.StoreErrorCode.options).toContain("owner_session_missing");
  });

  test("canonical digest is the shared protocol JSON owner", () => {
    expect(Trigger.canonicalDigest("abc")).toBe(canonicalDigest("abc"));
  });
});
