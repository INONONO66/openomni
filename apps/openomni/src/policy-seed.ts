import { SEEDED_POLICY_ROWS } from "@openomni/agent";
import { Storage } from "@openomni/ledger";
import type { PolicyRow } from "@openomni/protocol";

/** Seeds the kernel's mandatory generation before any durable session is materialized. */
export function seedKernelPolicyRows(): number {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("L0 storage capability is unavailable: policies");
  const budget = {
    name: "monitor-wake-budget",
    kind: "tool",
    phase: "pre" as const,
    priority: 900,
    match: { encodingVersion: 1 as const, value: { op: "monitor" } },
    verdict: {
      encodingVersion: 1 as const,
      value: { type: "obligation", name: "budget_clamp", metric: "notifications", limit: 8 },
    },
  };
  return policies.appendGeneration((current) => {
    const next = new Map([...SEEDED_POLICY_ROWS, budget].map((row) => [policyId(row), row]));
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
