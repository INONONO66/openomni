import { Effect } from "effect";
import {
  AlarmSeam,
  AlarmWakeError,
  ArmRefused,
  Capability,
  RESERVED_PURPOSES,
  type AlarmCapability,
  type ArmVerb,
  type CapabilityDefinition,
  type SeamTag,
} from "../../core/api";
import {
  createWatchVerb,
  type AlarmPurposeDeclaration,
  type AlarmPurposeHandler,
  type WatchInstallDeps,
  type WatchVerb,
} from "./watch";

// The frozen core/api seam, surfaced through the Bundle namespace for the
// app (the Core barrel does not export it; core/** is lane-untouchable).
export {
  AlarmWakeError,
  ArmRefused,
  RESERVED_PURPOSES,
  type AlarmCapability,
  type AlarmFired,
  type AlarmWakeContext,
  type AlarmWakeOutcome,
  type ArmVerb,
} from "../../core/api";
export {
  MONITOR_HIT,
  MONITOR_SOURCE,
  MONITOR_TIMEOUT,
  WatchHitPayload,
  WatchRefused,
  watchPurposes,
  type AlarmPromptVerb,
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
  /**
   * The app's committing arm verb, scoped to the session AND the calling
   * turn (#1254 r2 H3): tool-facing arms carry the turn token the live
   * activation checks; the capability only guards and delegates.
   */
  readonly arm: (sessionId: string, turnId: string) => ArmVerb;
  readonly watch: WatchInstallDeps;
}

/** What the app composes: the #1255 `Capability.define` result plus the composed verbs. */
export interface AlarmCapabilityDefinition extends AlarmCapability {
  /** The frozen `Capability.define` contract (#1255 S1). */
  readonly definition: CapabilityDefinition<"alarm">;
  readonly name: "alarm";
  readonly points: readonly ["alarm.fired"];
  /** purpose -> owning bundle; the core's reserved purposes map to "core". */
  readonly registry: ReadonlyMap<string, string>;
  readonly verbs: {
    readonly arm: (sessionId: string, turnId: string) => ArmVerb;
    readonly watch: WatchVerb;
  };
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
 * The alarm capability's `Capability.define` contract (#1255 S1): the verbs
 * are `arm` plus the watch verb composed over it. `alarmCapability` freezes
 * one per live on-set with the registry-guarded arm; the app's manifest lists
 * the purpose-free form (`purposes: {}`, raw arm) because the manifest's
 * bundle contracts declare their own purposes and compose rejects a duplicate.
 */
export function alarmContract(input: {
  readonly purposes: Readonly<Record<string, AlarmPurposeHandler>>;
  readonly arm: (sessionId: string, turnId: string) => ArmVerb;
  readonly watch: WatchInstallDeps;
}): CapabilityDefinition<"alarm", SeamTag, AlarmCapabilityDefinition["verbs"], AlarmPurposeHandler> {
  return Capability.define({
    name: "alarm",
    requires: [],
    points: ["alarm.fired"],
    purposes: input.purposes,
    verbs: { arm: input.arm, watch: createWatchVerb(input.arm, input.watch) },
    seam: AlarmSeam,
  });
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
        const arm = (sessionId: string, turnId: string) =>
          guardArm(registry, options.arm(sessionId, turnId));
        const definition = alarmContract({
          purposes: Object.fromEntries(handlers),
          arm,
          watch: options.watch,
        });
        return {
          definition,
          name: definition.name,
          points: definition.points as readonly ["alarm.fired"],
          purposes: Object.keys(definition.purposes),
          registry,
          wake,
          verbs: definition.verbs,
        };
      }),
    );
}
