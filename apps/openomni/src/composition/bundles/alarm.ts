import { Bundle } from "@openomni/agent";
import { Context, Layer } from "effect";

/**
 * The `alarm` bundle (#1254): provides the composed capability definition
 * under the bundle tag law. `monitor` and `cron` require it — with alarm
 * absent from the manifest they are selected OFF with a recorded reason
 * (compose's requirement check would otherwise refuse boot). The dependent
 * cascade mechanics proper land with #1255; this helper is that rule's
 * app-side seed.
 */
export const ALARM_CAPABILITY_KEY = "@openomni/bundle/alarm/Capability" as const;
export const AlarmCapabilityService = Object.assign(
  Context.Service<typeof ALARM_CAPABILITY_KEY, Bundle.AlarmCapabilityDefinition>(
    ALARM_CAPABILITY_KEY,
  ),
  { key: ALARM_CAPABILITY_KEY },
);

export function alarmBundle(definition: Bundle.AlarmCapabilityDefinition): Bundle.BundleDefinition {
  // Explicit type arguments: inferring O/E/I from the layer widens the
  // requirement channel and trips the bundle contract's type-level check.
  return Bundle.bundle<
    [typeof AlarmCapabilityService],
    [],
    typeof ALARM_CAPABILITY_KEY,
    never,
    never
  >({
    name: "alarm",
    provides: [AlarmCapabilityService],
    requires: [],
    layer: Layer.succeed(AlarmCapabilityService, definition),
  });
}

/** One disabled-bundle fact the selection records instead of refusing boot. */
export interface DisabledBundle {
  readonly bundle: string;
  readonly reason: string;
}

export interface AlarmBundleSelection {
  readonly definitions: readonly Bundle.BundleDefinition[];
  readonly disabled: readonly DisabledBundle[];
}

/**
 * Capability-off cascade: with no alarm capability, `monitor` and `cron`
 * are off with a recorded reason and boot proceeds; with it, all three
 * bundles compose in dependency order.
 */
export function selectAlarmBundles(input: {
  readonly alarm: Bundle.AlarmCapabilityDefinition | undefined;
  readonly dependents: readonly ((
    capability: typeof AlarmCapabilityService,
  ) => Bundle.BundleDefinition)[];
}): AlarmBundleSelection {
  if (input.alarm === undefined)
    return {
      definitions: [],
      disabled: input.dependents.map((make) => ({
        bundle: make(AlarmCapabilityService).name,
        reason: "requires @openomni/bundle/alarm/Capability: alarm capability not composed",
      })),
    };
  return {
    definitions: [
      alarmBundle(input.alarm),
      ...input.dependents.map((make) => make(AlarmCapabilityService)),
    ],
    disabled: [],
  };
}
