import type { CanonicalPolicyRegistration } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { InstructionLoader } from "./instructions";
import { SkillLoader } from "./skills";

export interface ContextMiddlewareConfig {
  workspaceRoot: string;
  globalConfigDir?: string;
}

// merged from assembler.ts (fragment sweep: single-consumer module)
export namespace ContextAssembler {
  export function assemble(config: ContextMiddlewareConfig): string {
    const { workspaceRoot, globalConfigDir } = config;

    const instructionFiles = InstructionLoader.discover(workspaceRoot, globalConfigDir);
    const instructionText = InstructionLoader.load(instructionFiles);

    const skills = SkillLoader.discover(workspaceRoot, globalConfigDir);
    const skillsText = SkillLoader.format(skills);

    if (!instructionText && !skillsText) return "";
    if (!skillsText) return instructionText;
    if (!instructionText) return skillsText;

    return `${instructionText}\n\n${skillsText}`;
  }
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
