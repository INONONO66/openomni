import { Bundle } from "@openomni/agent";
import { cronBundle } from "./bundles/cron";
import { delegationPolicyBundle } from "./bundles/delegation-policy";
import { hooksJsonBundle, type HooksJsonInput } from "./bundles/hooks-json";
import { monitorBundle } from "./bundles/monitor";
import { ToolCapabilitySeam } from "./bundles/seams";
import { sendMessageBundle } from "./bundles/send-message";

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
 * The action capability comes from the agent `Bundle` namespace (#1304): the
 * plugin owns the `action` kind, input, `action.pre` point and `ActionSeam`;
 * the manifest only composes it, so `off: ["action"]` still cascades `hook`,
 * `hooks-json` and `delegation-policy` off with `action` as the root.
 *
 * `off` comes from the Owner's `OPENOMNI_BUNDLES_OFF` tuple (`config.bundlesOff`);
 * compose owns the transitive off-cascade semantics.
 */
export interface AppManifestInput {
  /** The composed alarm capability's frozen `Capability.define` contract. */
  readonly alarm: Bundle.CapabilityDefinition<"alarm">;
  /** The watch wake dependencies the monitor bundle's purposes close over. */
  readonly wake: Bundle.WatchWakeDeps;
  /** The parsed hooks JSON config (#1256); absent composes zero hook rows. */
  readonly hooks?: HooksJsonInput;
  /** Owner-configured off names; absent means everything declared is on. */
  readonly off?: readonly string[];
}

export function appManifest(input: AppManifestInput): Bundle.ManifestDefinition {
  return Bundle.Manifest.define({
    // #1307: compaction is a declared, removable capability; `off:
    // ["compaction"]` records the typed disabled entry and the kernel runs
    // without it instead of falling back silently.
    capabilities: [
      toolCapability,
      Bundle.actionCapability(),
      Bundle.hookCapability(),
      Bundle.compactionCapability(),
      input.alarm,
    ],
    bundles: [
      monitorBundle(input.wake),
      cronBundle(),
      hooksJsonBundle(input.hooks),
      sendMessageBundle(),
      delegationPolicyBundle(),
    ],
    off: input.off ?? [],
  });
}
