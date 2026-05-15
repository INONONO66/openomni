import { Operational, PolicyDecision } from "@openomni/protocol";
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
        return PolicyDecision.allow({ policyId: "builtin.post_tool" });
      }
      if (!addition) return PolicyDecision.allow({ policyId: "builtin.post_tool" });
      const base = ctx.toolOutput ?? "";
      return PolicyDecision.allow({
        policyId: "builtin.post_tool",
        reasonCodes: ["post_tool_enrichment"],
        effects: [
          { type: "tool.rewrite_output", output: base ? `${base}\n${addition}` : addition },
        ],
      });
    },
  };
}

export const postToolFactory: PolicyFactory = {
  id: "policy:post-tool",
  create: (config) => createPostToolPolicy(config as PostToolEnricher),
};
