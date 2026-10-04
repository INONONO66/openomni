import { Bundle } from "@openomni/agent";

/**
 * The `monitor` bundle's purposes (#1254): the watch plane's two purposes
 * (`monitor.hit`, `monitor.timeout`) declared over the alarm capability. The
 * handlers live in `plugins/alarm` (`Bundle.watchPurposes`); the bundle's
 * `requires: alarm` edge and the capability-off cascade are #1255's compose
 * mechanics.
 */
export function monitorPurposes(deps: Bundle.WatchWakeDeps): Bundle.AlarmBundlePurposes {
  return { bundle: "monitor", purposes: Bundle.watchPurposes(deps) };
}
