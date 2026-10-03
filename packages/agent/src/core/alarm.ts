import { Effect, Schema } from "effect";
import { interruptOn } from "./ports";
import { Alarm, isReservedAlarmPurpose, RESERVED_ALARM_PURPOSES, type LedgerAction, type PlainObject } from "@openomni/protocol";
import type { RetryAlarmPort, RetryAlarmDeps } from "./alarm-ports";

export type { RetryAlarmPort, RetryAlarmDeps } from "./alarm-ports";

/**
 * Timer plane over cluster DeliverAt (#1254): a persisted timer message is
 * never cancelled in storage. Supersede = commit the winning `arm` row first;
 * a later delivery consults the chain through `alarmDisposition` and folds to
 * a recorded `fired{stale}` fact with zero execution.
 */

/** The four loop-reserved purposes, re-exported for the capability seam. */
export const RESERVED_PURPOSES = RESERVED_ALARM_PURPOSES;

/** Why a delivered occurrence is skipped instead of run. */
export type AlarmSkipReason = "superseded" | "settled" | "unknown";

export type AlarmDisposition =
  | { readonly op: "run" }
  | { readonly op: "skip"; readonly reason: AlarmSkipReason };

/** The latest committed `arm` row view for one alarm chain. */
export interface AlarmArmView {
  readonly occurrenceId: string;
  /** Epoch ms, or null when the arm retired the chain. */
  readonly at: number | null;
}

/** Chain reads one alarm delivery decides over; the entity supplies its kernel's read ports. */
export interface AlarmChainReads {
  /** Latest `alarm{arm}` row for `alarmId`, or undefined when the chain has none. */
  latestArm(alarmId: string): AlarmArmView | undefined;
  /** True when a `fired{delivered|exhausted}` row exists for the occurrence. */
  settled(occurrenceId: string): boolean;
}

/**
 * The one chain guard (#1254): an occurrence is fresh iff the latest `arm`
 * row for its alarm still names its `occurrenceId`, the arm is not retired
 * (`at !== null`), and no accepted (`delivered|exhausted`) firing settled it.
 */
export function alarmDisposition(
  reads: AlarmChainReads,
  occurrence: { readonly alarmId: string; readonly occurrenceId: string },
): AlarmDisposition {
  const arm = reads.latestArm(occurrence.alarmId);
  if (arm === undefined) return { op: "skip", reason: "unknown" };
  if (arm.occurrenceId !== occurrence.occurrenceId || arm.at === null)
    return { op: "skip", reason: "superseded" };
  if (reads.settled(occurrence.occurrenceId)) return { op: "skip", reason: "settled" };
  return { op: "run" };
}

function appendAlarm(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly intent: PlainObject;
  readonly effect: PlainObject;
  readonly revert?: PlainObject;
  readonly ts: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "alarm",
    intent: { encodingVersion: 1, value: input.intent },
    effect: { encodingVersion: 1, value: input.effect },
    ...(input.revert === undefined
      ? { irreversible: true as const }
      : { revert: { encodingVersion: 1 as const, value: input.revert } }),
    ts: input.ts,
  };
}

/**
 * Legacy generic `alarm` append constructor (pre-#1254 watch lifecycle rows
 * and the gate's retry.scheduled evidence). New code uses `armAction` /
 * `firedAction`; this stays until Lane 2 rewrites the watch plane.
 */
export function alarmAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly intent: PlainObject;
  readonly effect: PlainObject;
  readonly revert?: PlainObject;
  readonly ts: number;
}): LedgerAction.Append {
  return appendAlarm(input);
}

/**
 * One `alarm{arm}` row (#1254): mints the occurrence id from the arm's own
 * journal sequence (`armSeq`) inside the committing transaction. An
 * `at: null` arm retires the chain; `supersedes` names the previous
 * occurrence this arm replaces.
 */
export function armAction(input: {
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly purpose: string;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly alarmId: string;
  readonly sourceKey: string;
  readonly payload: PlainObject;
  readonly armSeq: number;
  readonly ts: number;
}): { readonly action: LedgerAction.Append; readonly occurrenceId: string } {
  const occurrenceId = Alarm.occurrenceId(input.sessionId, input.alarmId, input.armSeq, input.sourceKey);
  return {
    occurrenceId,
    action: appendAlarm({
      id: `${input.alarmId}:arm:${input.armSeq}`,
      parentId: input.parentId,
      sessionId: input.sessionId,
      intent: {
        op: "arm",
        purpose: input.purpose,
        at: input.at,
        supersedes: input.supersedes,
        alarmId: input.alarmId,
        sourceKey: input.sourceKey,
        payload: input.payload,
      },
      effect: { occurrenceId },
      ts: input.ts,
    }),
  };
}

/** One `alarm{fired}` row (#1254); idempotent per `<occurrenceId>:<outcome>` chain key. */
export function firedAction(input: {
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly outcome: "delivered" | "stale" | "exhausted";
  readonly ts: number;
}): LedgerAction.Append {
  return appendAlarm({
    id: `${input.occurrenceId}:${input.outcome}`,
    parentId: input.parentId,
    sessionId: input.sessionId,
    intent: {
      op: "fired",
      occurrenceId: input.occurrenceId,
      outcome: input.outcome,
      purpose: input.purpose,
      alarmId: input.alarmId,
    },
    effect: { op: "fired", occurrenceId: input.occurrenceId, outcome: input.outcome },
    ts: input.ts,
  });
}

/**
 * Boot alarm sweep config (#1254 S3; S4 nests it inside `AlarmDrainConfig`).
 * `full: true` rescans every session at boot; `full: false` rescans
 * `has_armed` sessions plus sessions idle for at least `idleDays` days.
 * Values come from the composition root's config, never from core constants.
 */
export interface AlarmSweepConfig {
  readonly full: boolean;
  readonly idleDays: number;
}

// ─── #1254 capability seam (frozen at S1: later steps add, never rename) ───

/** The fired occurrence view a capability's `wake` receives. */
export interface AlarmFired {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  /** Canonical JSON of the arm's payload. */
  readonly payload: string;
  readonly fireAt: number;
}

/** Typed `arm` refusal (#1254): the body's `deny{reason: alarm_budget}` is `code: "alarm_budget"`. */
export class ArmRefused extends Schema.TaggedError<ArmRefused>(
  "@openomni/agent/core/ArmRefused",
)("ArmRefused", {
  code: Schema.Literals(["alarm_budget", "unknown_purpose", "reserved_purpose"]),
}) {}

/** The arm verb a capability schedules through; never a direct journal append. */
export type ArmVerb = (input: {
  readonly purpose: string;
  readonly at: number | null;
  readonly payload: PlainObject;
  readonly alarmId?: string;
  readonly supersedes?: string;
  readonly sourceKey: string;
}) => Effect.Effect<{ readonly alarmId: string; readonly occurrenceId: string }, ArmRefused>;

/**
 * The accepted outcome a capability's wake returns (#1254): the core records
 * `fired{outcome: <returned>}` through `firedAction` — a capability never
 * builds an `alarm` append literal itself.
 */
export type AlarmWakeOutcome = "delivered" | "exhausted";

/** Typed wake failure a capability's purpose handler reports. */
export class AlarmWakeError extends Schema.TaggedError<AlarmWakeError>(
  "@openomni/agent/core/AlarmWakeError",
)("AlarmWakeError", {
  purpose: Schema.String,
  reason: Schema.String,
}) {}

/** What one wake dispatch hands a registered purpose handler. */
export interface AlarmWakeContext {
  readonly sessionId: string;
  /** Kernel chain reads (chain page by alarmId). */
  readonly reads: AlarmChainReads;
  readonly arm: ArmVerb;
  readonly now: number;
}

/** One alarm capability: declared purposes plus their wake dispatch. */
export interface AlarmCapability {
  readonly purposes: readonly string[];
  readonly wake: (fired: AlarmFired, ctx: AlarmWakeContext) => Effect.Effect<AlarmWakeOutcome, AlarmWakeError>;
}

/** Typed purpose-registry compose failure (#1254): no partial activation. */
export class AlarmComposeError extends Schema.TaggedError<AlarmComposeError>(
  "@openomni/agent/core/AlarmComposeError",
)("AlarmComposeError", {
  code: Schema.Literals(["reserved_purpose", "duplicate_purpose"]),
  purpose: Schema.String,
  bundle: Schema.String,
}) {}

/** purpose → owning bundle; the core's four reserved purposes are always present. */
export type AlarmPurposeRegistry = ReadonlyMap<string, string>;

/**
 * Composes the alarm purpose registry (#1254): reserved names and the
 * entity-internal `rescan` are rejected, duplicates are rejected, and the
 * core's four loop-reserved purposes are always present.
 */
export function composeAlarmPurposes(input: {
  readonly capabilities: readonly { readonly bundle: string; readonly purposes: readonly string[] }[];
}): Effect.Effect<AlarmPurposeRegistry, AlarmComposeError> {
  return Effect.suspend(() => {
    const registry = new Map<string, string>(
      RESERVED_PURPOSES.map((purpose) => [purpose, "core"] as const),
    );
    for (const capability of input.capabilities) {
      for (const purpose of capability.purposes) {
        if (isReservedAlarmPurpose(purpose) || purpose === "rescan")
          return Effect.fail(
            new AlarmComposeError({ code: "reserved_purpose", purpose, bundle: capability.bundle }),
          );
        if (registry.has(purpose))
          return Effect.fail(
            new AlarmComposeError({ code: "duplicate_purpose", purpose, bundle: capability.bundle }),
          );
        registry.set(purpose, capability.bundle);
      }
    }
    return Effect.succeed(registry);
  });
}

export function createRetryAlarmPort(deps: RetryAlarmDeps): RetryAlarmPort {
  return {
    // Chain evidence strictly before the persisted rearm: a crash between the
    // two resumes from the chain on activation; a crash inside the wait is
    // woken by the redelivered message, which no-ops when the live path won.
    arm: (input) =>
      deps
        .commitScheduled({
          id: input.id,
          attempt: input.attempt,
          reason: input.reason,
          notBefore: input.fireAt,
        })
        .pipe(
          Effect.flatMap(() =>
            deps.send({ alarmId: input.id, attempt: input.attempt, notBefore: input.fireAt }),
          ),
        ),
    wait: (fireAt, signal) =>
      Effect.suspend(() => {
        const sleep = Effect.sleep(Math.max(0, fireAt - deps.clock()));
        if (signal === undefined) return sleep;
        return sleep.pipe(Effect.raceFirst(interruptOn(signal)));
      }),
    settle: () => Effect.void,
  };
}
