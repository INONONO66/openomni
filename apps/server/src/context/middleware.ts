import type { PolicyRegistration } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { ContextAssembler } from "./assembler";

export interface ContextMiddlewareConfig {
  workspaceRoot: string;
  globalConfigDir?: string;
}

export function createContextMiddleware(config: ContextMiddlewareConfig): PolicyRegistration {
  return {
    name: "server:context",
    timing: "context.prepare",
    priority: 50,
    failPolicy: "fail-open",
    fn: async (_ctx) => {
      let assembled: string;
      try {
        assembled = ContextAssembler.assemble({
          workspaceRoot: config.workspaceRoot,
          globalConfigDir: config.globalConfigDir,
        });
      } catch {
        return PolicyDecision.allow({ policyId: "server.context" });
      }

      if (!assembled) return PolicyDecision.allow({ policyId: "server.context" });

      return PolicyDecision.allow({
        policyId: "server.context",
        effects: [{ type: "prompt.append_context", context: assembled }],
      });
    },
  };
}
