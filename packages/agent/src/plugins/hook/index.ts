import { Capability, seam, type CapabilityDefinition, type SeamTag } from "../../core/api";
import { hookProcessConsultant } from "./consultant";
import { acquireHookProcess, HOOK_PROCESS_REF } from "./process";

export { hookProcessConsultant } from "./consultant";

export {
  acquireHookProcess,
  HOOK_PROCESS_REF,
  HookGateVerdict,
  HookSpawnError,
  type HookCallInput,
  type HookOutcome,
  type HookProcess,
  type HookProcessConfig,
} from "./process";

/**
 * The removable `plugins/hook` capability (#1256): no journal kind, no point,
 * no input, no model tool — exactly one `how.ref` handler target
 * (`hook/process`) other declarations reference, plus the scoped
 * process-acquisition verb the product composes inside a generation's Scope.
 * `requires: ["action"]` is a seam NAME resolved by compose, never an import:
 * hook results re-enter the session only as `action` rows through the entity
 * `deliver` path, so turning `action` off cascades `hook` (and every bundle
 * over it) off with the root recorded as `because`.
 */

/** The seam a product bundle's `requires` resolves against at compose. */
export const HookSeam: SeamTag = seam("@openomni/hook/Hook");

/** The verbs the hook capability publishes over its seam. */
export interface HookVerbs {
  /** Spawns ONE hook PID inside the caller's Scope — the generation lifetime. */
  readonly acquire: typeof acquireHookProcess;
}

/** The hook capability's `Capability.define` contract (#1256). */
export function hookCapability(): CapabilityDefinition<"hook", SeamTag, HookVerbs> {
  return Capability.define({
    name: "hook",
    requires: ["action"],
    // #1256 r2 H-1: the registration IS the consultant — compiled rows naming
    // `hook/process` consult the scoped process the composition acquires here.
    handlers: { [HOOK_PROCESS_REF]: { consultant: hookProcessConsultant } },
    verbs: { acquire: acquireHookProcess },
    seam: HookSeam,
  });
}
