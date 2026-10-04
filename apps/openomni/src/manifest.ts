import { Bundle } from "@openomni/agent";
import { Context } from "effect";
import { cronBundle } from "./bundles/cron";
import { monitorBundle } from "./bundles/monitor";

/** The tool capability's seam tag; no bundle consumes it yet, compose requires one. */
class ToolCapabilitySeam extends Context.Service<ToolCapabilitySeam, object>()(
  "@openomni/openomni/ToolCapabilitySeam",
) {}

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
  seam: ToolCapabilitySeam as Bundle.SeamTag,
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
    bundles: [monitorBundle(input.wake), cronBundle()],
    off: input.off ?? [],
  });
}
