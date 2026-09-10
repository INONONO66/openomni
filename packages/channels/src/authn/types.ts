import type { Policy } from "@openomni/protocol";

interface ChannelAuthnDecision {
  readonly timing: Policy.Timing;
  readonly name: string;
  readonly policyId: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
  readonly durationMs: number;
}

export type ChannelAuthnDecisionObserver = (decision: ChannelAuthnDecision) => void | Promise<void>;
