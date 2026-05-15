import { Operational, PolicyDecision, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { PolicyContext, PolicyFactory, PolicyRegistration } from "../types";

export type PostTurnHandler = (
  ctx: PolicyContext,
) => Promise<Policy.PolicyDecision> | Policy.PolicyDecision;

export function createPostTurnPolicy(handler: PostTurnHandler): PolicyRegistration {
  return {
    name: "builtin:post-turn",
    timing: "turn.finish",
    priority: 250,
    fn: async (ctx) => {
      try {
        return await handler(ctx);
      } catch (error) {
        Bus.publish(Operational.Debug, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy.post-turn",
          msg: "post-turn handler failed",
          context: { error: String(error) },
        });
        return PolicyDecision.allow({ policyId: "builtin.post_turn" });
      }
    },
  };
}

export const postTurnFactory: PolicyFactory = {
  id: "policy:post-turn",
  create: (config) => createPostTurnPolicy(config as PostTurnHandler),
};
