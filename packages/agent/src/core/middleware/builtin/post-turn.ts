import { Operational, type Hook } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { MiddlewareContext, MiddlewareRegistration } from "../types";

export type PostTurnHandler = (ctx: MiddlewareContext) => Promise<Hook.Verdict> | Hook.Verdict;

export function createPostTurnMiddleware(handler: PostTurnHandler): MiddlewareRegistration {
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
          component: "agent.middleware.post-turn",
          msg: "post-turn handler failed",
          context: { error: String(error) },
        });
        return { action: "continue" };
      }
    },
  };
}
