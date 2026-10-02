import type { PolicyRow, Storage as ProtocolStorage } from "@openomni/protocol";
import { SEEDED_POLICY_ROWS } from "../../src/kernel/gate/compile";
import { isolatedLedger } from "./isolated";

/** Seeds the mandatory policy rows plus `rows` into the catalog's policy plane at generation 1. */
export function seedPolicy(
  rows: readonly Omit<PolicyRow.Row, "generation">[] = [],
  policies: ProtocolStorage.PolicyRowSubAdapter = isolatedLedger().catalog.policies,
): void {
  for (const row of [...SEEDED_POLICY_ROWS, ...rows]) policies.append({ ...row, generation: 1 });
}
