import { z } from "zod";
import { canonicalDigest } from "../json.js";
import { EpochMs } from "../time.js";
import * as Schema from "./schema.js";

const TimerDue = z
  .object({ type: z.literal("timer_due"), at: EpochMs, fireMaterial: Schema.FireMaterial })
  .strict();
const SourceObservation = z
  .object({
    type: z.literal("source_observation"),
    batch: Schema.PendingBatch,
    at: EpochMs,
    terminalReason: Schema.TerminalFireReason.optional(),
    fireMaterial: Schema.FireMaterial,
  })
  .strict();
const DeliveryAcknowledged = z
  .object({
    type: z.literal("delivery_acknowledged"),
    fireId: z.string().min(1),
    at: EpochMs,
    admission: Schema.FireAdmission,
    nextReservation: z
      .object({
        pendingFingerprint: Schema.CanonicalDigest,
        reservation: Schema.FireReservation,
      })
      .strict()
      .optional(),
  })
  .strict();
const Pause = z
  .object({ type: z.literal("pause"), reason: Schema.PauseReason, at: EpochMs })
  .strict();
const Rearm = z.object({ type: z.literal("rearm"), at: EpochMs }).strict();
const Cancel = z
  .object({
    type: z.literal("cancel"),
    at: EpochMs,
    detail: z.string().max(Schema.Constants.MAX_DETAIL_CHARS).optional(),
    terminalBatch: Schema.PendingBatch.optional(),
    fireMaterial: Schema.FireMaterial.optional(),
  })
  .strict();
const SourceClosed = z
  .object({
    type: z.literal("source_closed"),
    reason: Schema.TerminalFireReason,
    at: EpochMs,
    detail: z.string().max(Schema.Constants.MAX_DETAIL_CHARS).optional(),
    terminalBatch: Schema.PendingBatch,
    fireMaterial: Schema.FireMaterial,
  })
  .strict();
const Restore = z
  .object({ type: z.literal("restore"), at: EpochMs, fireMaterial: Schema.FireMaterial.optional() })
  .strict();

export const SchedulerInput = z.discriminatedUnion("type", [
  TimerDue,
  SourceObservation,
  DeliveryAcknowledged,
  Pause,
  Rearm,
  Cancel,
  SourceClosed,
  Restore,
]);
export type SchedulerInput = z.infer<typeof SchedulerInput>;

export const SchedulerEffect = z.discriminatedUnion("type", [
  z.object({ type: z.literal("arm"), dueAt: EpochMs }).strict(),
  z.object({ type: z.literal("cancel_timer") }).strict(),
  z.object({ type: z.literal("reserve_fire"), fireId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("activate_source") }).strict(),
  z.object({ type: z.literal("pause_source") }).strict(),
  z.object({ type: z.literal("end") }).strict(),
]);
export type SchedulerEffect = z.infer<typeof SchedulerEffect>;

export interface SchedulerResult {
  readonly record: Schema.Record;
  readonly effects: readonly SchedulerEffect[];
}

function refusal(record: Schema.Record, message: string): never {
  throw new Schema.StoreError({
    code: "invalid_transition",
    triggerId: record.id,
    message,
  });
}

function logicalAt(record: Schema.Record, at: number): number {
  return Math.max(at, record.lastObservedAt);
}

function saturatedAdd(left: number, right: number): number {
  return Math.min(Schema.Constants.MAX_COUNTER, left + right);
}

function fingerprint(batch: Omit<Schema.PendingBatch, "fingerprint">): string {
  return canonicalDigest({
    items: batch.items,
    overflowCount: batch.overflowCount,
    scheduleMarker: batch.scheduleMarker,
    ...(batch.scheduledForAt === undefined ? {} : { scheduledForAt: batch.scheduledForAt }),
    firstAt: batch.firstAt,
    lastAt: batch.lastAt,
    ...(batch.terminalReason === undefined ? {} : { terminalReason: batch.terminalReason }),
  });
}

function mergePending(
  record: Schema.Record,
  previous: Schema.PendingBatch | undefined,
  incoming: Schema.PendingBatch,
): Schema.PendingBatch {
  if (previous === undefined) return incoming;
  if (incoming.terminalReason !== undefined) return incoming;
  if (previous.terminalReason !== undefined) return previous;
  if (previous.scheduleMarker || incoming.scheduleMarker) {
    if (!previous.scheduleMarker || !incoming.scheduleMarker) {
      // Only a corrupt row can pair a time-source schedule marker with an
      // event-source batch; the fold refuses rather than inventing a merge.
      throw new Schema.StoreError({
        code: "corrupt",
        triggerId: record.id,
        message: `Trigger ${record.id} pending batch mixes a schedule marker with source items`,
      });
    }
    const facts = {
      items: [] as Schema.SourceItem[],
      overflowCount: 0,
      scheduleMarker: true,
      scheduledForAt: incoming.scheduledForAt,
      firstAt: Math.min(previous.firstAt, incoming.firstAt),
      lastAt: Math.max(previous.lastAt, incoming.lastAt),
    };
    return Schema.PendingBatch.parse({ ...facts, fingerprint: fingerprint(facts) });
  }
  const items = [...previous.items, ...incoming.items].slice(
    0,
    Schema.Constants.NOTIFIER_MAX_LINES,
  );
  const omitted = previous.items.length + incoming.items.length - items.length;
  const facts = {
    items,
    overflowCount: saturatedAdd(
      saturatedAdd(previous.overflowCount, incoming.overflowCount),
      omitted,
    ),
    scheduleMarker: false,
    firstAt: Math.min(previous.firstAt, incoming.firstAt),
    lastAt: Math.max(previous.lastAt, incoming.lastAt),
  };
  // The schema is the rendered-character budget owner. If concatenation is
  // too large, drop from the tail and count what was omitted. A single item is
  // bounded well below the budget, so the surviving prefix is never empty while
  // items exist; an item-free batch is already inside the budget by definition.
  let candidate = facts;
  for (;;) {
    const parsed = Schema.PendingBatch.safeParse({
      ...candidate,
      fingerprint: fingerprint(candidate),
    });
    if (parsed.success) return parsed.data;
    candidate = {
      ...candidate,
      items: candidate.items.slice(0, -1),
      overflowCount: saturatedAdd(candidate.overflowCount, 1),
    };
  }
}

function assertMaterial(
  record: Schema.Record,
  material: Schema.FireMaterial,
  batch?: Schema.PendingBatch,
): Schema.FireMaterial {
  const parsed = Schema.FireMaterial.parse(material);
  if (batch !== undefined && parsed.pendingBatch.fingerprint !== batch.fingerprint) {
    refusal(record, `Trigger ${record.id} Fire material does not describe the observation batch`);
  }
  return parsed;
}

function reserveOrCoalesce(
  record: Schema.Record,
  material: Schema.FireMaterial,
  at: number,
): { record: Schema.Record; effect?: SchedulerEffect } {
  if (record.inFlightFireId !== undefined) {
    const pendingBatch = mergePending(record, record.pendingBatch, material.pendingBatch);
    return {
      record: Schema.Record.parse({
        ...record,
        pendingBatch,
        coalescedFirePending: true,
        lastObservedAt: at,
        updatedAt: at,
        revision: record.revision + 1,
      }),
    };
  }
  return {
    record: Schema.Record.parse({
      ...record,
      inFlightFireId: material.reservation.id,
      fireCount: saturatedAdd(record.fireCount, 1),
      lastFiredAt: material.reservation.firedAt,
      lastObservedAt: at,
      updatedAt: at,
      revision: record.revision + 1,
    }),
    effect: { type: "reserve_fire", fireId: material.reservation.id },
  };
}

function endRecord(
  record: Schema.Record,
  reason: Schema.EndReason,
  at: number,
  detail?: string,
): Schema.Record {
  let pendingBatch = record.pendingBatch;
  if (
    pendingBatch !== undefined &&
    pendingBatch.terminalReason === undefined &&
    !pendingBatch.scheduleMarker
  ) {
    pendingBatch = undefined;
  }
  return Schema.Record.parse({
    ...record,
    lifecycle: {
      state: "ended",
      endReason: reason,
      endedAt: at,
      ...(detail === undefined ? {} : { endDetail: detail }),
    },
    pendingBatch,
    coalescedFirePending: pendingBatch !== undefined,
    lastObservedAt: at,
    updatedAt: at,
    revision: record.revision + 1,
  });
}

function terminalTransition(
  record: Schema.Record,
  batch: Schema.PendingBatch,
  material: Schema.FireMaterial,
  reason: Schema.TerminalFireReason,
  at: number,
  detail?: string,
): SchedulerResult {
  if (batch.terminalReason !== reason) {
    refusal(record, `Trigger ${record.id} terminal batch reason does not match ${reason}`);
  }
  const accepted = reserveOrCoalesce(record, assertMaterial(record, material, batch), at);
  const ended = endRecord(accepted.record, reason, at, detail);
  return {
    record: ended,
    effects: [
      ...(accepted.effect === undefined ? [] : [accepted.effect]),
      { type: "cancel_timer" },
      { type: "end" },
    ],
  };
}

function nextRecurringAt(record: Schema.Record, at: number): number {
  const expiry = record.expiresAt;
  const interval = record.effectiveIntervalMs;
  if (expiry === undefined || interval === undefined)
    refusal(record, "recurring Trigger has no deadline");
  return interval >= expiry - at ? expiry : at + interval;
}

function timerDue(
  record: Schema.Record,
  at: number,
  material: Schema.FireMaterial,
): SchedulerResult {
  if (record.lifecycle.state !== "armed") {
    return { record, effects: [{ type: "cancel_timer" }] };
  }
  const logical = logicalAt(record, at);
  if (record.source.kind === "time.once") {
    if (logical < record.source.at) {
      return { record, effects: [{ type: "arm", dueAt: record.source.at }] };
    }
    const accepted = reserveOrCoalesce(record, assertMaterial(record, material), logical);
    const ended = endRecord(accepted.record, "completed", logical);
    return {
      record: ended,
      effects: [
        ...(accepted.effect === undefined ? [] : [accepted.effect]),
        { type: "cancel_timer" },
        { type: "end" },
      ],
    };
  }
  if (record.source.kind !== "time.every") refusal(record, "event Trigger received timer_due");
  const dueAt = record.nextFireAt;
  const expiresAt = record.expiresAt;
  if (dueAt === undefined || expiresAt === undefined)
    refusal(record, "recurring Trigger lacks schedule");
  if (logical < dueAt) return { record, effects: [{ type: "arm", dueAt }] };
  if (logical >= expiresAt) {
    return {
      record: endRecord(record, "expired", logical),
      effects: [{ type: "cancel_timer" }, { type: "end" }],
    };
  }
  const accepted = reserveOrCoalesce(record, assertMaterial(record, material), logical);
  const next = nextRecurringAt(record, logical);
  let nextRecord = Schema.Record.parse({ ...accepted.record, nextFireAt: next });
  const effects: SchedulerEffect[] = accepted.effect === undefined ? [] : [accepted.effect];
  if (next >= expiresAt) {
    nextRecord = endRecord(nextRecord, "expired", logical);
    effects.push({ type: "cancel_timer" }, { type: "end" });
  } else {
    effects.push({ type: "arm", dueAt: next });
  }
  return { record: nextRecord, effects };
}

function restore(record: Schema.Record, input: z.infer<typeof Restore>): SchedulerResult {
  if (record.lifecycle.state === "ended") return { record, effects: [] };
  const at = logicalAt(record, input.at);
  if (record.source.kind === "time.once") {
    if (record.lifecycle.state === "armed" && at >= record.source.at) {
      if (input.fireMaterial === undefined)
        refusal(record, "due once restore requires Fire material");
      return timerDue(record, at, input.fireMaterial);
    }
    const restored = Schema.Record.parse({
      ...record,
      lastObservedAt: at,
      updatedAt: at,
      revision: record.revision + 1,
    });
    return {
      record: restored,
      effects:
        record.lifecycle.state === "armed"
          ? [{ type: "arm", dueAt: record.source.at }]
          : [{ type: "cancel_timer" }],
    };
  }
  if (record.source.kind === "time.every") {
    // The Record refinement guarantees a recurring expiry, so this comparison is
    // the whole expiry decision — no cast and no unreachable defensive branch.
    if (record.expiresAt !== undefined && at >= record.expiresAt) {
      return {
        record: endRecord(record, "expired", at),
        effects: [{ type: "cancel_timer" }, { type: "end" }],
      };
    }
    if (
      record.lifecycle.state === "armed" &&
      record.nextFireAt !== undefined &&
      at >= record.nextFireAt
    ) {
      if (input.fireMaterial === undefined)
        refusal(record, "due recurring restore requires Fire material");
      return timerDue(record, at, input.fireMaterial);
    }
    const restored = Schema.Record.parse({
      ...record,
      lastObservedAt: at,
      updatedAt: at,
      revision: record.revision + 1,
    });
    return {
      record: restored,
      effects:
        record.lifecycle.state === "armed" && record.nextFireAt !== undefined
          ? [{ type: "arm", dueAt: record.nextFireAt }]
          : [{ type: "cancel_timer" }],
    };
  }
  if (record.expiresAt !== undefined && at >= record.expiresAt) {
    if (input.fireMaterial === undefined)
      refusal(record, "finite source restore requires timeout material");
    return terminalTransition(
      record,
      input.fireMaterial.pendingBatch,
      input.fireMaterial,
      "source_timeout",
      at,
    );
  }
  const restored = Schema.Record.parse({
    ...record,
    lastObservedAt: at,
    updatedAt: at,
    revision: record.revision + 1,
  });
  return {
    record: restored,
    effects: [
      ...(record.expiresAt === undefined
        ? []
        : [{ type: "arm" as const, dueAt: record.expiresAt }]),
      ...(record.lifecycle.state === "armed" ? [{ type: "activate_source" as const }] : []),
    ],
  };
}

export function step(candidate: Schema.Record, rawInput: SchedulerInput): SchedulerResult {
  const record = Schema.Record.parse(candidate);
  const input = SchedulerInput.parse(rawInput);
  if (record.revision >= Schema.Constants.MAX_COUNTER)
    refusal(record, "Trigger revision is exhausted");

  switch (input.type) {
    case "timer_due":
      return timerDue(record, input.at, input.fireMaterial);
    case "source_observation": {
      if (record.lifecycle.state !== "armed")
        refusal(record, "source observation requires armed Trigger");
      if (!record.source.kind.startsWith("event."))
        refusal(record, "time Trigger received source observation");
      const at = logicalAt(record, input.at);
      if (record.expiresAt !== undefined && at >= record.expiresAt) {
        refusal(record, "source observation reached its inclusive expiry");
      }
      if (input.terminalReason !== undefined) {
        return terminalTransition(
          record,
          input.batch,
          input.fireMaterial,
          input.terminalReason,
          at,
        );
      }
      const accepted = reserveOrCoalesce(
        record,
        assertMaterial(record, input.fireMaterial, input.batch),
        at,
      );
      return {
        record: accepted.record,
        effects: accepted.effect === undefined ? [] : [accepted.effect],
      };
    }
    case "source_closed": {
      if (record.lifecycle.state === "ended") return { record, effects: [] };
      if (!record.source.kind.startsWith("event."))
        refusal(record, "time Trigger received source closure");
      return terminalTransition(
        record,
        input.terminalBatch,
        input.fireMaterial,
        input.reason,
        logicalAt(record, input.at),
        input.detail,
      );
    }
    case "cancel": {
      if (record.lifecycle.state === "ended") return { record, effects: [] };
      const at = logicalAt(record, input.at);
      if (record.source.kind.startsWith("event.")) {
        if (input.terminalBatch === undefined || input.fireMaterial === undefined) {
          refusal(record, "event Trigger cancellation requires terminal material");
        }
        return terminalTransition(
          record,
          input.terminalBatch,
          input.fireMaterial,
          "cancelled",
          at,
          input.detail,
        );
      }
      return {
        record: endRecord(
          Schema.Record.parse({
            ...record,
            pendingBatch: undefined,
            coalescedFirePending: false,
          }),
          "cancelled",
          at,
          input.detail,
        ),
        effects: [{ type: "cancel_timer" }, { type: "end" }],
      };
    }
    case "pause": {
      if (record.lifecycle.state === "ended") refusal(record, "ended Trigger cannot pause");
      if (record.lifecycle.state === "paused") return { record, effects: [] };
      const at = logicalAt(record, input.at);
      const paused = Schema.Record.parse({
        ...record,
        lifecycle: { state: "paused", pauseReason: input.reason, pausedAt: at },
        lastObservedAt: at,
        updatedAt: at,
        revision: record.revision + 1,
      });
      return {
        record: paused,
        effects: [
          ...(record.source.kind.startsWith("time.")
            ? [{ type: "cancel_timer" as const }]
            : record.expiresAt === undefined
              ? []
              : [{ type: "arm" as const, dueAt: record.expiresAt }]),
          { type: "pause_source" },
        ],
      };
    }
    case "rearm": {
      if (record.lifecycle.state !== "paused") refusal(record, "only a paused Trigger can rearm");
      const at = logicalAt(record, input.at);
      if (
        record.source.kind === "time.every" &&
        record.expiresAt !== undefined &&
        at >= record.expiresAt
      ) {
        return { record: endRecord(record, "expired", at), effects: [{ type: "end" }] };
      }
      if (
        record.source.kind.startsWith("event.") &&
        record.expiresAt !== undefined &&
        at >= record.expiresAt
      ) {
        refusal(record, "finite source rearm at expiry requires restore timeout material");
      }
      const nextFireAt =
        record.source.kind === "time.every" ? nextRecurringAt(record, at) : record.nextFireAt;
      const armed = Schema.Record.parse({
        ...record,
        lifecycle: { state: "armed" },
        ...(nextFireAt === undefined ? {} : { nextFireAt }),
        lastObservedAt: at,
        updatedAt: at,
        revision: record.revision + 1,
      });
      const due =
        record.source.kind === "time.once"
          ? record.source.at
          : record.source.kind === "time.every"
            ? nextFireAt
            : record.expiresAt;
      return {
        record: armed,
        effects: [
          ...(due === undefined ? [] : [{ type: "arm" as const, dueAt: due }]),
          ...(record.source.kind.startsWith("event.")
            ? [{ type: "activate_source" as const }]
            : []),
        ],
      };
    }
    case "restore":
      return restore(record, input);
    case "delivery_acknowledged": {
      if (record.inFlightFireId !== input.fireId)
        refusal(record, "acknowledgement does not match in-flight Fire");
      const at = logicalAt(record, input.at);
      if (record.pendingBatch === undefined) {
        if (input.nextReservation !== undefined)
          refusal(record, "ack supplied a reservation without pending work");
        return {
          record: Schema.Record.parse({
            ...record,
            inFlightFireId: undefined,
            lastObservedAt: at,
            updatedAt: at,
            revision: record.revision + 1,
          }),
          effects: [],
        };
      }
      if (
        input.nextReservation === undefined ||
        input.nextReservation.pendingFingerprint !== record.pendingBatch.fingerprint
      ) {
        refusal(record, "pending acknowledgement reservation fingerprint mismatch");
      }
      const reservation = Schema.FireReservation.parse(input.nextReservation.reservation);
      return {
        record: Schema.Record.parse({
          ...record,
          inFlightFireId: reservation.id,
          pendingBatch: undefined,
          coalescedFirePending: false,
          fireCount: saturatedAdd(record.fireCount, 1),
          lastFiredAt: reservation.firedAt,
          lastObservedAt: at,
          updatedAt: at,
          revision: record.revision + 2,
        }),
        effects: [{ type: "reserve_fire", fireId: reservation.id }],
      };
    }
  }
}
