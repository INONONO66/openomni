import { Bundle } from "@openomni/agent";
import { Cron } from "@openomni/protocol";
import { Effect, Layer } from "effect";
import { z } from "zod";
import type { ALARM_CAPABILITY_KEY, AlarmCapabilityService } from "./alarm";

/**
 * The `cron` bundle (#1254): one `cron.tick` purpose over the alarm
 * capability. A tick wakes with its grid time; the handler prompts once
 * (carrying the count of grid times missed while the host was down — there
 * is no catch-up storm), then re-arms the chain at the next grid time with
 * `supersedes`. State is the chain; nothing rides process memory.
 */
export const CRON_TICK = "cron.tick";
export const CRON_SOURCE = "cron";

/** The arm payload a cron chain carries from arm to arm. */
export const CronPayload = z
  .object({
    expr: z.string().min(1),
    tz: z.string().min(1),
    description: z.string(),
  })
  .strict();
export type CronPayload = z.infer<typeof CronPayload>;

export interface CronWakeDeps {
  // #1254 S4: ctx.prompt
  readonly prompt: Bundle.AlarmPromptVerb;
}

function cronTick(deps: CronWakeDeps): Bundle.AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* Effect.try({
        try: () => CronPayload.parse(JSON.parse(fired.payload)),
        catch: () => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "payload" }),
      });
      const grid = yield* Effect.try({
        try: () => ({
          /** Grid times in (fireAt, now] beyond the due one: ticks lost to downtime. */
          missed: Math.max(
            0,
            Cron.occurrences(payload.expr, fired.fireAt, ctx.now, payload.tz).length - 1,
          ),
          next: Cron.next(payload.expr, Math.max(ctx.now, fired.fireAt), payload.tz),
        }),
        catch: () => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "cron_expr" }),
      });
      yield* deps.prompt({
        content: JSON.stringify({
          kind: CRON_TICK,
          description: payload.description,
          expr: payload.expr,
          firedAt: fired.fireAt,
          missed: grid.missed,
        }),
        payload: { expr: payload.expr, missed: grid.missed },
      });
      yield* ctx
        .arm({
          purpose: CRON_TICK,
          at: grid.next,
          alarmId: fired.alarmId,
          supersedes: fired.occurrenceId,
          sourceKey: CRON_SOURCE,
          payload,
        })
        .pipe(
          Effect.mapError(
            (refused) => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: refused.code }),
          ),
        );
      return "delivered" as const;
    });
}

/** The cron bundle's purpose declaration for the capability composition. */
export function cronPurposes(deps: CronWakeDeps): Bundle.AlarmBundlePurposes {
  return { bundle: "cron", purposes: [{ name: CRON_TICK, handler: cronTick(deps) }] };
}

/** The bundle itself: a pure dependency edge on the alarm capability. */
export function cronBundle(capability: typeof AlarmCapabilityService): Bundle.BundleDefinition {
  // Explicit type arguments: see `alarmBundle`.
  return Bundle.bundle<[], [typeof AlarmCapabilityService], never, never, typeof ALARM_CAPABILITY_KEY>({
    name: "cron",
    provides: [],
    requires: [capability],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        yield* capability;
      }),
    ),
  });
}
