import type { MiddlewareContext, MiddlewareRegistration } from "../types";

export type PostToolEnricher = (ctx: MiddlewareContext) => string | null | Promise<string | null>;

export function createPostToolMiddleware(enricher: PostToolEnricher): MiddlewareRegistration {
  return {
    name: "builtin:post-tool",
    timing: "post_tool_use",
    priority: 200,
    fn: async (ctx) => {
      let addition: string | null;
      try {
        addition = await enricher(ctx);
      } catch {
        return { action: "continue" };
      }
      if (!addition) return { action: "continue" };
      const base = ctx.toolOutput ?? "";
      return {
        action: "transform",
        input: { output: base ? `${base}\n${addition}` : addition },
      };
    },
  };
}
