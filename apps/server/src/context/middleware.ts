import type { CanonicalPolicyRegistration } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { ContextAssembler } from "./assembler";

export interface ContextMiddlewareConfig {
  workspaceRoot: string;
  globalConfigDir?: string;
}

export function createContextMiddleware(
  config: ContextMiddlewareConfig,
): CanonicalPolicyRegistration {
  return {
    name: "server:context",
    kind: "point",
    pointIds: ["prompt.context.pre"],
    effectCapabilities: { "prompt.context.pre": ["prompt.append_context"] },
    priority: 50,
    failPolicy: "fail-open",
    fn: async (_ctx) => {
      let assembled: string;
      try {
        assembled = ContextAssembler.assemble({
          workspaceRoot: config.workspaceRoot,
          globalConfigDir: config.globalConfigDir,
        });
      } catch (error) {
        if (error instanceof Error) {
          return PolicyDecision.allow({ policyId: "server.context" });
        }
        throw error;
      }

      if (!assembled) return PolicyDecision.allow({ policyId: "server.context" });

      return PolicyDecision.allow({
        policyId: "server.context",
        effects: [{ type: "prompt.append_context", context: assembled }],
      });
    },
  };
}
