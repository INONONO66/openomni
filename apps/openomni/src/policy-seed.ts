import { SEEDED_POLICY_ROWS } from "@openomni/agent";
import { Storage } from "@openomni/ledger";

/** Seeds the kernel's mandatory generation before any durable session is materialized. */
export function seedKernelPolicyRows(): number {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("L0 storage capability is unavailable: policies");
  const current = policies.rows();
  const latest = Math.max(0, ...current.map((row) => row.generation));
  if (current.some((row) => row.generation === latest && row.name === "monitor-wake-budget"))
    return latest;
  const generation = latest + 1;
  const base =
    latest === 0 ? SEEDED_POLICY_ROWS : current.filter((row) => row.generation === latest);
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
  for (const row of [...base, budget]) {
    if (!policies.append({ ...row, generation })) {
      throw new Error(`could not seed policy row: ${row.name}`);
    }
  }
  return generation;
}
