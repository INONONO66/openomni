import { SEEDED_POLICY_ROWS } from "@openomni/agent";
import { Storage } from "@openomni/ledger";
import { MESSAGE_POLICY_ROWS } from "./message-policy";

/** Seeds the kernel's mandatory generation before any durable session is materialized. */
export function seedKernelPolicyRows(): number {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("L0 storage capability is unavailable: policies");
  const stored = policies.rows();
  const latest = stored.reduce((value, row) => Math.max(value, row.generation), 0);
  const current = stored.filter((row) => row.generation === latest);
  const missing = MESSAGE_POLICY_ROWS.filter(
    (required) => !current.some((row) => row.name === required.name && row.kind === required.kind),
  );
  if (latest > 0 && missing.length === 0) return latest;
  const generation = latest + 1;
  Storage.get().transaction(() => {
    for (const row of [...(latest === 0 ? SEEDED_POLICY_ROWS : current), ...missing]) {
      if (!policies.append({ ...row, generation })) {
        throw new Error(`could not seed policy row: ${row.name}`);
      }
    }
  });
  return generation;
}
