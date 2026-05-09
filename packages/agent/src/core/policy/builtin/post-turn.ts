import type { PolicyContext, PolicyRegistration, PolicyVerdict } from "../types";
import { Log } from "@openomni/session";

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
        Log.debug("post-turn handler failed", { error });
        return { action: "continue" };
      }
    },
  };
}
