import { Bundle } from "@openomni/agent";
import { cronBundle } from "./bundles/cron";
import { monitorBundle } from "./bundles/monitor";
import { sendMessageBundle } from "./bundles/send-message";
import { ToolCapabilitySeam } from "./bundles/seams";

/**
 * The thin tool-capability contract (#1255 P3): the dispatcher stays the
 * composition-wired core loop, but the capability that OWNS the `tool.pre` /
 * `tool.post` points (and the kernel budget-clamp obligation bundle rows may
 * consult) must be declared for `compose` to accept rows on them — the
 * monitor bundle's wake-budget row targets `tool.pre`.
 */
export const toolCapability = Bundle.Capability.define({
  name: "tool",
  requires: [],
  points: ["tool.pre", "tool.post"],
  handlers: { "kernel/budget-clamp": {} },
  verbs: {},
  seam: ToolCapabilitySeam,
});

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
    capabilities: [toolCapability, input.alarm],
    bundles: [monitorBundle(input.wake), cronBundle(), sendMessageBundle()],
    off: input.off ?? [],
  });
}
