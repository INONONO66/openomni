import { Storage } from "@openomni/ledger";
import type { PolicyRow } from "@openomni/protocol";
import { SEEDED_POLICY_ROWS } from "../../src/index";

/** Seeds the mandatory policy rows plus `rows` into the initialized storage at generation 1. */
export function seedPolicy(rows: readonly Omit<PolicyRow.Row, "generation">[] = []): void {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("missing policy adapter");
  for (const row of [...SEEDED_POLICY_ROWS, ...rows]) policies.append({ ...row, generation: 1 });
}
