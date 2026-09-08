import { SEEDED_POLICY_ROWS } from "@openomni/agent";
import { Storage } from "@openomni/ledger";
import type { PolicyRow } from "@openomni/protocol";
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
    value: { type: "obligation", name: "budget_clamp", metric: "notifications", limit: 8 },
  },
};

/** The kernel's mandatory rows: the agent seed, message routing, provisioning consent, the wake budget. */
const KERNEL_POLICY_ROWS: readonly Omit<PolicyRow.Row, "generation">[] = [
  ...SEEDED_POLICY_ROWS,
  ...MESSAGE_POLICY_ROWS,
  ...PROVISION_POLICY_ROWS,
  MONITOR_WAKE_BUDGET,
];

/** Seeds the kernel's mandatory generation before any durable session is materialized. */
export function seedKernelPolicyRows(): number {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("L0 storage capability is unavailable: policies");
  return policies.appendGeneration((current) => {
    const next = new Map(KERNEL_POLICY_ROWS.map((row) => [policyId(row), row]));
    // Preserve existing policy values and site-specific ids; fill missing mandatory ids.
    for (const row of current) next.set(policyId(row), row);
    const currentIds = new Set(current.map(policyId));
    if (currentIds.size === next.size && [...next.keys()].every((id) => currentIds.has(id))) {
      return undefined;
    }
    return [...next.values()];
  });
}

function policyId(row: Omit<PolicyRow.Row, "generation">): string {
  return JSON.stringify([row.name, row.kind, row.phase]);
}
