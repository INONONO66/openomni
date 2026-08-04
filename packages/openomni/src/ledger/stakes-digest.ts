import { createHash } from "node:crypto";

export type StakesHashValue = null | boolean | number | string | readonly StakesHashValue[];

export function hashStakesValue(value: StakesHashValue): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
