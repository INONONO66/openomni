import type { PolicyContext, PolicyRegistration } from "../types";
import { Log } from "@openomni/session";

export type PostToolEnricher = (ctx: PolicyContext) => string | null | Promise<string | null>;

export function createPostToolMiddleware(enricher: PostToolEnricher): PolicyRegistration {
  return {
    name: "builtin:post-tool",
    timing: "post_tool_use",
    priority: 200,
    fn: async (ctx) => {
      let addition: string | null;
      try {
        addition = await enricher(ctx);
      } catch (error) {
        Log.debug("post-tool enricher failed", { error });
        return { action: "continue" };
      }
      if (!addition) return { action: "continue" };
      const base = ctx.toolOutput ?? "";
      return {
        action: "transform",
        input: { output: base ? `${base}\n${addition}` : addition },
        reason: "post_tool_enrichment",
        policyId: "builtin.post_tool",
      };
    },
  };
}
