import {
  STAKES_POLICY_VERSION,
  createStakesSchemas,
  type StakesWindow as StakesWindowType,
  type StakesWindowInput,
} from "./stakes-contract.js";
import { hashStakesValue } from "./stakes-digest.js";
import { expectedStakesComparison, expectedWindowRef } from "./stakes-reference.js";

export { hashStakesValue };
const InternalSchemas = createStakesSchemas();

export function stakesWindowRef(window: StakesWindowInput): string {
  return expectedWindowRef(window);
}

export function createStakesWindow(input: unknown): StakesWindowType {
  const parsed = InternalSchemas.StakesWindowInput.parse(input);
  return InternalSchemas.StakesWindow.parse({
    ...parsed,
    version: "stakes-window-v1",
    policyVersion: STAKES_POLICY_VERSION,
    windowRef: stakesWindowRef(parsed),
  });
}

export function compareStakesValue(value: number): "below" | "at" | "above" {
  return expectedStakesComparison(value);
}
