/**
 * Dependency-free leaf shared by stakes-contract.ts and stakes-reference.ts.
 *
 * These values used to live in stakes-contract.ts, which made contract ↔
 * reference a two-way value-import cycle — safe only because the back
 * references sat inside superRefine closures while createStakesSchemas() runs
 * at contract module init. Keeping them in a leaf with no ledger imports
 * makes the remaining contract → reference edge one-way by construction.
 */
import { createHash } from "node:crypto";

export const STAKES_POLICY_VERSION = "stakes-policy-v1";
export const STAKES_THETA = 1_000;

export type StakesHashValue = null | boolean | number | string | readonly StakesHashValue[];

export function hashStakesValue(value: StakesHashValue): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
