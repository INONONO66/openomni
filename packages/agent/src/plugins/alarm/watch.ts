import { Effect, Schema } from "effect";
import { Alarm } from "@openomni/protocol";
import { z } from "zod";
import {
  AlarmWakeError,
  type ArmRefused,
  type AlarmFired,
  type AlarmWakeContext,
  type AlarmWakeOutcome,
  type ArmVerb,
} from "../../core/api";

/**
 * Watch plane over the #1254 alarm lifecycle: a watch is an armed alarm
 * (`alarmId = watchId`, `sourceKey: "monitor"`) whose payload carries the
 * sealed spec and the wake budget consumed so far. A native occurrence
 * arrives as a `monitor.hit` wake; re-arm is a new `arm` with `supersedes`;
 * retiring is an `at: null` arm — there is no cancel action and no generation counter.
 * Timed watches arm a second alarm (`alarmId = <watchId>:timeout`) consumed
 * by `monitor.timeout`.
 */

/** The watch plane's two purposes (the body's `monitor.hit`; `watch.*` literals are gone). */
export const MONITOR_HIT = "monitor.hit";
export const MONITOR_TIMEOUT = "monitor.timeout";
/** Occurrence-minter source key for every watch-plane arm. */
export const MONITOR_SOURCE = "monitor";

/** One registered purpose handler: the capability's wake dispatch target. */
export type AlarmPurposeHandler = (input: {
  readonly fired: AlarmFired;
  readonly ctx: AlarmWakeContext;
}) => Effect.Effect<AlarmWakeOutcome, AlarmWakeError>;

/** One purpose a bundle declares through the capability. */
export interface AlarmPurposeDeclaration {
  readonly name: string;
  readonly handler: AlarmPurposeHandler;
}

/**
 * The arm payload of a watch chain, plus the native hit detail the source
 * adapter merges onto the occurrence it (re)sends. `notifications` is the
 * budget consumed by committed wakes — budget state rides the chain, never
 * process memory.
 */
export const WatchHitPayload = z
  .object({
    spec: Alarm.WatchSpec,
    notifications: z.number().int().nonnegative(),
    hit: z
      .object({
        content: z.string(),
        terminal: z.boolean(),
        /** Transport detail (PTY line slot, path stat identity, exit) — never an id. */
        detail: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WatchHitPayload = z.infer<typeof WatchHitPayload>;

const WatchTimeoutPayload = z.object({ watchId: z.string().min(1) }).strict();

/** Typed watch-verb refusal (spec or native-source install). */
export class WatchRefused extends Schema.TaggedError<WatchRefused>(
  "@openomni/agent/plugins/alarm/WatchRefused",
)("WatchRefused", {
  reason: Schema.String,
}) {}

/** The core's alarm-originated prompt verb (`AlarmWakeContext.prompt`; origin `alarm` is fixed by the core). */
export type AlarmPromptVerb = AlarmWakeContext["prompt"];

/** What the wake handlers need from the app: the native-source closer (the prompt rides the wake context). */
export interface WatchWakeDeps {
  /** Fire-and-forget close of the process-local native source. */
  readonly close: (watchId: string) => void;
}

/** Install seam for the native source adapter (PTY command / fs path). */
export interface WatchInstallDeps {
  readonly install: (input: {
    readonly sessionId: string;
    readonly watchId: string;
    readonly spec: Alarm.WatchSpec;
    /** The armed occurrence a native hit resends (the cluster dedupes on it). */
    readonly occurrence: { readonly occurrenceId: string; readonly alarmId: string };
  }) => Effect.Effect<void, WatchRefused>;
}

function parsePayload<S extends z.ZodType>(
  schema: S,
  fired: AlarmFired,
): Effect.Effect<z.infer<S>, AlarmWakeError> {
  return Effect.try({
    try: () => schema.parse(JSON.parse(fired.payload)),
    catch: () => new AlarmWakeError({ purpose: fired.purpose, reason: "payload" }),
  });
}

function armToWake(fired: AlarmFired): (refused: ArmRefused) => AlarmWakeError {
  return (refused) => new AlarmWakeError({ purpose: fired.purpose, reason: refused.code });
}

/** Retires a watch chain: an `at: null` arm superseding the named occurrence. */
function retire(
  ctx: AlarmWakeContext,
  fired: AlarmFired,
  alarmId: string,
  supersedes: string,
  reason: string,
): Effect.Effect<void, AlarmWakeError> {
  return ctx
    .arm({
      purpose: MONITOR_HIT,
      at: null,
      alarmId,
      supersedes,
      sourceKey: MONITOR_SOURCE,
      payload: { reason },
    })
    .pipe(Effect.mapError(armToWake(fired)), Effect.asVoid);
}

/**
 * `monitor.hit`: commit the wake prompt, then either retire (terminal hit),
 * exhaust (budget spent — the core records `fired{exhausted}` from the
 * returned outcome), or re-arm with `supersedes` and the spent budget.
 */
function monitorHit(deps: WatchWakeDeps): AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* parsePayload(WatchHitPayload, fired);
      const hit = payload.hit;
      if (hit === undefined)
        return yield* new AlarmWakeError({ purpose: fired.purpose, reason: "missing_hit" });
      yield* ctx.prompt({ content: hit.content, payload: { watchId: fired.alarmId, detail: hit.detail } });
      if (hit.terminal) {
        yield* retire(ctx, fired, fired.alarmId, fired.occurrenceId, "fired");
        deps.close(fired.alarmId);
        return "delivered" as const;
      }
      const notifications = payload.notifications + 1;
      if (notifications >= payload.spec.notificationLimit) {
        yield* retire(ctx, fired, fired.alarmId, fired.occurrenceId, "exhausted");
        deps.close(fired.alarmId);
        return "exhausted" as const;
      }
      yield* ctx
        .arm({
          purpose: MONITOR_HIT,
          at: ctx.now,
          alarmId: fired.alarmId,
          supersedes: fired.occurrenceId,
          sourceKey: MONITOR_SOURCE,
          payload: { spec: payload.spec, notifications },
        })
        .pipe(Effect.mapError(armToWake(fired)));
      return "delivered" as const;
    });
}

/** `monitor.timeout`: one terminal wake that retires the main watch chain. */
function monitorTimeout(deps: WatchWakeDeps): AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* parsePayload(WatchTimeoutPayload, fired);
      yield* ctx.prompt({
        content: JSON.stringify({ watchId: payload.watchId, reason: "timeout" }),
        payload: { watchId: payload.watchId, reason: "timeout" },
      });
      const latest = ctx.reads.latestArm(payload.watchId);
      if (latest !== undefined && latest.at !== null)
        yield* retire(ctx, fired, payload.watchId, latest.occurrenceId, "timeout");
      deps.close(payload.watchId);
      return "delivered" as const;
    });
}

/** The watch plane's purpose declarations — the monitor bundle hands these to the capability. */
export function watchPurposes(deps: WatchWakeDeps): readonly AlarmPurposeDeclaration[] {
  return [
    { name: MONITOR_HIT, handler: monitorHit(deps) },
    { name: MONITOR_TIMEOUT, handler: monitorTimeout(deps) },
  ];
}

/** The `watch` verb: validate the sealed spec, arm the chain(s), install the native source. */
export type WatchVerb = (input: {
  readonly sessionId: string;
  readonly watchId: string;
  readonly spec: Alarm.WatchSpec;
  readonly now: number;
}) => Effect.Effect<
  { readonly alarmId: string; readonly occurrenceId: string },
  ArmRefused | WatchRefused
>;

export function createWatchVerb(
  armFor: (sessionId: string) => ArmVerb,
  deps: WatchInstallDeps,
): WatchVerb {
  return (input) =>
    Effect.gen(function* () {
      const parsed = Alarm.WatchSpec.safeParse(input.spec);
      if (!parsed.success)
        return yield* new WatchRefused({
          reason: parsed.error.issues[0]?.message ?? "invalid watch spec",
        });
      const spec = parsed.data;
      const arm = armFor(input.sessionId);
      const main = yield* arm({
        purpose: MONITOR_HIT,
        at: input.now,
        alarmId: input.watchId,
        sourceKey: MONITOR_SOURCE,
        payload: { spec, notifications: 0 },
      });
      if (spec.watch.timeout_ms !== undefined)
        yield* arm({
          purpose: MONITOR_TIMEOUT,
          at: input.now + spec.watch.timeout_ms,
          alarmId: `${input.watchId}:timeout`,
          sourceKey: MONITOR_SOURCE,
          payload: { watchId: input.watchId },
        });
      yield* deps.install({
        sessionId: input.sessionId,
        watchId: input.watchId,
        spec,
        occurrence: main,
      });
      return main;
    });
}
