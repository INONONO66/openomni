import { SEEDED_POLICY_ROWS } from "@openomni/agent";
import { Storage } from "@openomni/ledger";

/** Seeds the kernel's mandatory generation before any durable session is materialized. */
export function seedKernelPolicyRows(): number {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("L0 storage capability is unavailable: policies");
  const generations = policies.rows().map((row) => row.generation);
  if (generations.length > 0) return Math.max(...generations);
  const generation = 1;
  for (const row of SEEDED_POLICY_ROWS) {
    if (!policies.append({ ...row, generation })) {
      throw new Error(`could not seed policy row: ${row.name}`);
    }
  }
  return generation;
}
