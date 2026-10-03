import { Kernel } from "@openomni/agent";
import { Context } from "effect";

/**
 * The merged point registration table of THIS composition (#1251): derived
 * from the capability registrations the composition root actually selects.
 * A capability omitted from the composition has no points, so its rows
 * reject fail-closed at boot seeding and at generation compile.
 */
export class AppPointTable extends Context.Service<AppPointTable, Kernel.GatePointTable>()(
  "@openomni/openomni/AppPointTable",
) {}

/** Composes the table from the selected capabilities; the default selection is every built-in this app ships. */
export function composedPointTable(
  capabilities: readonly Kernel.CapabilityPointRegistration[] = Kernel.KERNEL_CAPABILITY_POINTS,
): Kernel.GatePointTable {
  return Kernel.composePointTable({ capabilities });
}
