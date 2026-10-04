import { Bundle } from "@openomni/agent";
import { cronBundle } from "./bundles/cron";
import { monitorBundle } from "./bundles/monitor";

/**
 * The product manifest (#1255): THE one place openomni lists what is on —
 * its capabilities and its bundles — as plain data for `compose`. Boot is
 * config → manifest → compose → runtime; nothing else enumerates bundles.
 *
 * `off` comes from the Owner's `OPENOMNI_BUNDLES_OFF` tuple (`config.bundlesOff`);
 * compose owns the transitive off-cascade semantics.
 */
export interface AppManifestInput {
  /** The composed alarm capability's frozen `Capability.define` contract. */
  readonly alarm: Bundle.CapabilityDefinition<"alarm">;
  /** The watch wake dependencies the monitor bundle's purposes close over. */
  readonly wake: Bundle.WatchWakeDeps;
  /** Owner-configured off names; absent means everything declared is on. */
  readonly off?: readonly string[];
}

export function appManifest(input: AppManifestInput): Bundle.ManifestDefinition {
  return Bundle.Manifest.define({
    capabilities: [input.alarm],
    bundles: [monitorBundle(input.wake), cronBundle()],
    off: input.off ?? [],
  });
}
