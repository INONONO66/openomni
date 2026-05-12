import { Operational, type Hook } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { PolicyContext, PolicyRegistration } from "../types";

export type PostTurnHandler = (ctx: PolicyContext) => Promise<Hook.Verdict> | Hook.Verdict;

export function createPostTurnPolicy(handler: PostTurnHandler): PolicyRegistration {
  return {
    name: "builtin:post-turn",
    timing: "post_turn",
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
        return { action: "continue" };
      }
    },
  };
}
