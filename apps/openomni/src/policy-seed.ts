import { Kernel } from "@openomni/agent";
const SEEDED_POLICY_ROWS = Kernel.SEEDED_POLICY_ROWS;
const { assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } = Kernel;
import type { PolicyRow, Storage as ProtocolStorage } from "@openomni/protocol";
import { composedPointTable } from "./composition/point-table";
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
  /** The composition's merged point table (#1251); the default is the full built-in composition this app ships. */
  table: Kernel.GatePointTable = composedPointTable(),
): number {
  return policies.appendGeneration((current) => {
    // Convert the latest generation's semantics onto the fourteen-point
    // contract and validate every row BEFORE any early return: a completed
    // generation carrying an unmappable custom row still rejects the boot.
    const converted = current.map((row) => translateLegacyPolicyRow(row));
    assertPointGenerationRows(converted, table);
    const next = new Map([...KERNEL_POLICY_ROWS, ...bundleRows].map((row) => [policyId(row), row]));
    // Preserve existing policy values and site-specific ids; fill missing mandatory ids.
    for (const row of converted) next.set(policyId(row), row);
    // The rows this boot writes must themselves map onto the composition's
    // points: a composition without a capability refuses its rows at seed.
    assertPointGenerationRows([...next.values()], table);
    // Identity compares the STORED rows: a conversion that changed any row's
    // point identity must land as a new generation even when the converted
    // set already matches the target.
    const storedIds = new Set(current.map(policyId));
    if (storedIds.size === next.size && [...next.keys()].every((id) => storedIds.has(id))) {
      return undefined;
    }
    return [...next.values()];
  });
}

function policyId(row: Omit<PolicyRow.Row, "generation">): string {
  return JSON.stringify([row.name, row.kind, row.phase]);
}
