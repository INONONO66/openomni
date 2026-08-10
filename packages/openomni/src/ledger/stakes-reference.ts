import { STAKES_POLICY_VERSION, STAKES_THETA, hashStakesValue } from "./stakes-contract.js";

type WindowIdentity = Readonly<{
  ownerKey: string;
  windowId: string;
  openedAt: number;
  closesAt: number;
}>;

type StakesReferenceInput = Readonly<{
  policyVersion: string;
  inputDigest: string;
  windowRef: string;
  axes: Readonly<{
    irreversibility: number;
    externalSurface: number;
    spend: number;
    budget: number;
    outreach: number;
    novelty: number;
  }>;
  value: number;
  theta: number;
  comparison: "below" | "at" | "above";
  includedActionIds: readonly string[];
}>;

export function expectedWindowRef(window: WindowIdentity): string {
  return hashStakesValue([
    "stakes-window-v1",
    STAKES_POLICY_VERSION,
    window.ownerKey,
    window.windowId,
    window.openedAt,
    window.closesAt,
  ]);
}

export function expectedStakesComparison(value: number): "below" | "at" | "above" {
  if (value < STAKES_THETA) return "below";
  if (value === STAKES_THETA) return "at";
  return "above";
}

export function expectedStakesReference(stakes: StakesReferenceInput): string {
  return hashStakesValue([
    "stakes-reference-v1",
    stakes.policyVersion,
    stakes.inputDigest,
    stakes.windowRef,
    stakes.axes.irreversibility,
    stakes.axes.externalSurface,
    stakes.axes.spend,
    stakes.axes.budget,
    stakes.axes.outreach,
    stakes.axes.novelty,
    stakes.value,
    stakes.theta,
    stakes.comparison,
    stakes.includedActionIds,
  ]);
}
