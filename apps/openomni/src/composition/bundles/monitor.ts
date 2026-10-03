import { Bundle } from "@openomni/agent";
import { Effect, Layer } from "effect";
import type { ALARM_CAPABILITY_KEY, AlarmCapabilityService } from "./alarm";

/**
 * The `monitor` bundle (#1254): declares the watch plane's two purposes
 * (`monitor.hit`, `monitor.timeout`) over the alarm capability. The handlers
 * themselves live in `plugins/alarm` (`Bundle.watchPurposes`); this bundle's
 * dependency edge is what the capability-off cascade switches on.
 */
export function monitorBundle(capability: typeof AlarmCapabilityService): Bundle.BundleDefinition {
  // Explicit type arguments: see `alarmBundle`.
  return Bundle.bundle<[], [typeof AlarmCapabilityService], never, never, typeof ALARM_CAPABILITY_KEY>({
    name: "monitor",
    provides: [],
    requires: [capability],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        yield* capability;
      }),
    ),
  });
}

/** The monitor bundle's purpose declarations for the capability composition. */
export function monitorPurposes(deps: Bundle.WatchWakeDeps): Bundle.AlarmBundlePurposes {
  return { bundle: "monitor", purposes: Bundle.watchPurposes(deps) };
}
