import { Effect } from "effect";
import {
  AlarmWakeError,
  ArmRefused,
  RESERVED_PURPOSES,
  type AlarmCapability,
  type ArmVerb,
} from "../../core/api";
import {
  createWatchVerb,
  type AlarmPurposeDeclaration,
  type AlarmPurposeHandler,
  type WatchInstallDeps,
  type WatchVerb,
} from "./watch";

export {
  MONITOR_HIT,
  MONITOR_SOURCE,
  MONITOR_TIMEOUT,
  WatchHitPayload,
  WatchRefused,
  watchPurposes,
  type AlarmPurposeDeclaration,
  type AlarmPurposeHandler,
  type WatchInstallDeps,
  type WatchVerb,
  type WatchWakeDeps,
} from "./watch";

/**
 * The removable `plugins/alarm` capability (#1254): purpose registry, wake
 * dispatch, the watch plane, and the `arm`/`watch` verbs. It imports only its
 * own plugin and `core/api.ts`; it never builds an `alarm` journal literal —
 * arming is always the injected `ArmVerb` (the run loop's commit path).
 */

/** One bundle's purpose declarations (`requires: alarm`). */
export interface AlarmBundlePurposes {
  readonly bundle: string;
  readonly purposes: readonly AlarmPurposeDeclaration[];
}

/**
 * Structural view of `Core.composeAlarmPurposes` — injected because a plugin
 * may import only `core/api.ts`, and the compose check stays Lane 1's single
 * implementation.
 */
export type ComposePurposesVerb<E> = (input: {
  readonly capabilities: readonly {
    readonly bundle: string;
    readonly purposes: readonly string[];
  }[];
}) => Effect.Effect<ReadonlyMap<string, string>, E>;

export interface AlarmCapabilityOptions<E> {
  readonly bundles: readonly AlarmBundlePurposes[];
  readonly compose: ComposePurposesVerb<E>;
  /** The app's committing arm verb; the capability only guards and delegates. */
  readonly arm: ArmVerb;
  readonly watch: WatchInstallDeps;
}

/** What the app composes: the #1255 capability shape as it exists today. */
export interface AlarmCapabilityDefinition extends AlarmCapability {
  readonly name: "alarm";
  readonly points: readonly ["alarm.fired"];
  /** purpose -> owning bundle; the core's reserved purposes map to "core". */
  readonly registry: ReadonlyMap<string, string>;
  readonly verbs: { readonly arm: ArmVerb; readonly watch: WatchVerb };
}

/** Reserved and unregistered purposes are typed arm refusals, never appends. */
function guardArm(registry: ReadonlyMap<string, string>, raw: ArmVerb): ArmVerb {
  return (input) => {
    if (
      (RESERVED_PURPOSES as readonly string[]).includes(input.purpose) ||
      input.purpose === "rescan"
    )
      return Effect.fail(new ArmRefused({ code: "reserved_purpose" }));
    if (!registry.has(input.purpose))
      return Effect.fail(new ArmRefused({ code: "unknown_purpose" }));
    return raw(input);
  };
}

/**
 * The one export the app composes. Reserved/`rescan`/duplicate purpose names
 * are refused through the injected compose verb (no partial activation); the
 * wake dispatch routes a fired occurrence to its registered handler, and an
 * unregistered purpose is a typed wake failure with zero handler execution.
 */
export function alarmCapability<E>(
  options: AlarmCapabilityOptions<E>,
): Effect.Effect<AlarmCapabilityDefinition, E> {
  return options
    .compose({
      capabilities: options.bundles.map((declaration) => ({
        bundle: declaration.bundle,
        purposes: declaration.purposes.map((purpose) => purpose.name),
      })),
    })
    .pipe(
      Effect.map((registry) => {
        const handlers = new Map<string, AlarmPurposeHandler>();
        for (const declaration of options.bundles)
          for (const purpose of declaration.purposes)
            handlers.set(purpose.name, purpose.handler);
        const wake: AlarmCapability["wake"] = (fired, ctx) => {
          const handler = handlers.get(fired.purpose);
          return handler === undefined
            ? Effect.fail(
                new AlarmWakeError({ purpose: fired.purpose, reason: "unregistered_purpose" }),
              )
            : handler({ fired, ctx });
        };
        const arm = guardArm(registry, options.arm);
        return {
          name: "alarm" as const,
          points: ["alarm.fired"] as const,
          purposes: [...handlers.keys()],
          registry,
          wake,
          verbs: { arm, watch: createWatchVerb(arm, options.watch) },
        };
      }),
    );
}
