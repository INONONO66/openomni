import { Kernel } from "@openomni/agent";
const SEEDED_POLICY_ROWS = Kernel.SEEDED_POLICY_ROWS;
const { assertPointGenerationRows, composePointTable, KERNEL_CAPABILITY_POINTS, POINT_GENERATION_ROW } = Kernel;

/** The merged core+capability point registration table the boot validates rows against (#1251). */
const POINT_TABLE = composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
import type { PolicyRow, Storage as ProtocolStorage } from "@openomni/protocol";
import { MESSAGE_POLICY_ROWS } from "./message-policy";
import { PROVISION_POLICY_ROWS } from "./tools/provision";

const MONITOR_WAKE_BUDGET: Omit<PolicyRow.Row, "generation"> = {
  name: "monitor-wake-budget",
  kind: "tool",
  phase: "pre",
  priority: 900,
  match: { encodingVersion: 1, value: { op: "monitor" } },
  verdict: {
    encodingVersion: 1,
    value: { type: "obligation", ref: "kernel/budget-clamp", metric: "notifications", limit: 8 },
  },
};

/** The kernel's mandatory rows: the agent seed, message routing, provisioning consent, the wake budget. */
const KERNEL_POLICY_ROWS: readonly Omit<PolicyRow.Row, "generation">[] = [
  ...SEEDED_POLICY_ROWS,
  ...MESSAGE_POLICY_ROWS,
  ...PROVISION_POLICY_ROWS,
  MONITOR_WAKE_BUDGET,
  POINT_GENERATION_ROW,
];

/**
 * Seeds the kernel's mandatory generation into the catalog's policy plane and
 * converts the latest generation once into a validated fourteen-point
 * generation (#1251): historical generations keep their exact bytes, and a
 * latest row that cannot map to a registered point rejects the whole write
 * unit, failing the boot.
 */
export function seedKernelPolicyRows(
  policies: ProtocolStorage.PolicyRowSubAdapter,
  bundleRows: readonly Omit<PolicyRow.Row, "generation">[] = [],
): number {
  return policies.appendGeneration((current) => {
    const next = new Map([...KERNEL_POLICY_ROWS, ...bundleRows].map((row) => [policyId(row), row]));
    // Preserve existing policy values and site-specific ids; fill missing mandatory ids.
    for (const row of current) next.set(policyId(row), row);
    const currentIds = new Set(current.map(policyId));
    if (currentIds.size === next.size && [...next.keys()].every((id) => currentIds.has(id))) {
      return undefined;
    }
    const drafts = [...next.values()];
    assertPointGenerationRows(drafts, POINT_TABLE);
    return drafts;
  });
}

function policyId(row: Omit<PolicyRow.Row, "generation">): string {
  return JSON.stringify([row.name, row.kind, row.phase]);
}
