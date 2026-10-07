import { Journal, type PlainValue } from "@openomni/protocol";
import {
  AgentInvariantViolation,
  Capability,
  seam,
  type CapabilityDefinition,
  type SeamTag,
} from "../../core/api";

/**
 * The removable `plugins/action` capability (#1304, moved from the product
 * manifest where #1256/#1258 first declared it inline): it owns the
 * protocol's `action` journal kind, admits `action` as a `deliver` input and
 * owns the `action.pre` gate point. Two dependents hang off it: the hook
 * capability's `requires: ["action"]` resolves it by NAME, and the product's
 * delegation-policy bundle requires `ActionSeam` — so `off: ["action"]`
 * cascades `hook`, `hooks-json` and `delegation-policy` off together with
 * `action` recorded as the root `because`.
 */

/** The seam a product bundle's `requires` resolves against at compose. */
export const ActionSeam: SeamTag = seam("@openomni/action/Action");

/**
 * The action capability's `Capability.define` contract. The kind schema and
 * version come from the protocol's closed capability-declaration list; the
 * reducer is identity because an action row is a deferred INPUT consumed by
 * delivery, never folded session state.
 */
export function actionCapability(): CapabilityDefinition<"action", SeamTag, object> {
  const declaration = Journal.CAPABILITY_DECLARATIONS.find((entry) => entry.kind === "action");
  // Invariant, not a refusal: the protocol's closed kind list declares `action`.
  if (declaration === undefined) throw new AgentInvariantViolation("action kind not declared");
  return Capability.define({
    name: "action",
    requires: [],
    kinds: {
      action: {
        schema: declaration.schema,
        version: declaration.version,
        reduce: (state: PlainValue) => state,
      },
    },
    inputs: ["action"],
    points: ["action.pre"],
    verbs: {},
    seam: ActionSeam,
  });
}
