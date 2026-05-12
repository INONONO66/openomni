import type { PolicyRegistration } from "@openomni/agent";
import { ContextAssembler } from "./assembler";

export interface ContextMiddlewareConfig {
  workspaceRoot: string;
  globalConfigDir?: string;
}

export function createContextMiddleware(config: ContextMiddlewareConfig): PolicyRegistration {
  return {
    name: "server:context",
    timing: "on_system_prompt",
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
        return { action: "continue" };
      }

      if (!assembled) return { action: "continue" };

      return {
        action: "transform",
        input: { appendContext: assembled },
      };
    },
  };
}
