import type { Channel, Policy } from "@openomni/protocol";

export type ChannelAuthnPolicyId = string;

interface ChannelAuthnDecision {
  readonly timing: Policy.Timing;
  readonly name: string;
  readonly policyId: ChannelAuthnPolicyId;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}

export type ChannelAuthnDecisionObserver = (decision: ChannelAuthnDecision) => void | Promise<void>;

export interface WebSocketAuthResult {
  readonly verdict: Policy.PolicyDecision;
  readonly protocol?: string;
  readonly response?: Response;
}

export interface GitHubAuthResult {
  readonly verdict: Policy.PolicyDecision;
  readonly body?: string;
  readonly response?: Response;
}

export interface ChannelTriggerAuthResult {
  readonly verdict: Policy.PolicyDecision;
}

export interface ChannelTriggerAuthInput {
  readonly triggers: Channel.TriggerRule[];
  readonly ctx: Channel.TriggerContext;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}
