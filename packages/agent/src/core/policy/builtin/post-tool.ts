import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { PolicyContext, PolicyFactory, PolicyRegistration } from "../types";

export type PostToolEnricher = (ctx: PolicyContext) => string | null | Promise<string | null>;

export function createPostToolPolicy(enricher: PostToolEnricher): PolicyRegistration {
  return {
    name: "builtin:post-tool",
    timing: "invoke.result",
    priority: 200,
    fn: async (ctx) => {
      let addition: string | null;
      try {
        addition = await enricher(ctx);
      } catch (error) {
        Bus.publish(Operational.Debug, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy.post-tool",
          msg: "post-tool enricher failed",
          context: { error: String(error) },
        });
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

export const postToolFactory: PolicyFactory = {
  id: "policy:post-tool",
  create: (config) => createPostToolPolicy(config as PostToolEnricher),
};
