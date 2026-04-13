import type { Hook } from "@openomni/protocol";
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
      } catch {
        return { action: "continue" };
      }
    },
  };
}
