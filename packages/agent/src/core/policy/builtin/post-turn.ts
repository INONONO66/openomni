import type { PolicyContext, PolicyRegistration, PolicyVerdict } from "../types";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

export type PostTurnHandler = (ctx: PolicyContext) => Promise<PolicyVerdict> | PolicyVerdict;

export function createPostTurnMiddleware(handler: PostTurnHandler): PolicyRegistration {
  return {
    name: "builtin:post-turn",
    timing: "post_turn",
    priority: 250,
    fn: async (ctx) => {
      try {
        return await handler(ctx);
      } catch (error) {
        Bus.publish(Operational.Debug, {
          traceId: ctx.traceContext?.traceId ?? crypto.randomUUID(),
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
