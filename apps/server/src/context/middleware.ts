import type { CanonicalPolicyRegistration } from "@openomni/agent";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { InstructionLoader } from "./instructions";
import { SkillLoader } from "./skills";

export interface ContextMiddlewareConfig {
  workspaceRoot: string;
  globalConfigDir?: string;
}

// merged from assembler.ts (fragment sweep: single-consumer module)
export namespace ContextAssembler {
  /** `traceId` is the run's dispatch trace (D11) — loader warns inherit it, never mint. */
  export function assemble(config: ContextMiddlewareConfig, traceId: string): string {
    const { workspaceRoot, globalConfigDir } = config;

    const instructionFiles = InstructionLoader.discover(workspaceRoot, traceId, globalConfigDir);
    const instructionText = InstructionLoader.load(instructionFiles, traceId);

    const skills = SkillLoader.discover(workspaceRoot, traceId, globalConfigDir);
    const skillsText = SkillLoader.format(skills);

    if (!instructionText && !skillsText) return "";
    if (!skillsText) return instructionText;
    if (!instructionText) return skillsText;

    return `${instructionText}\n\n${skillsText}`;
  }
}

/**
 * The trace context assembly reports under. Assembly happens inside a run —
 * the lifecycle always supplies the trace (`buildLifecyclePolicyContext`);
 * a missing one is a wiring bug, refused rather than papered over with a
 * fallback mint (precedent: tool-permission-policy's requireGuardTraceId).
 */
function requireContextTraceId(ctx: {
  readonly traceContext?: { readonly traceId?: string };
}): string {
  const traceId = ctx.traceContext?.traceId;
  if (traceId === undefined || traceId.length === 0) {
    throw new Error("context middleware requires the run trace context");
  }
  return traceId;
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
    fn: async (ctx) => {
      const traceId = requireContextTraceId(ctx);
      let assembled: string;
      try {
        assembled = ContextAssembler.assemble(
          {
            workspaceRoot: config.workspaceRoot,
            globalConfigDir: config.globalConfigDir,
          },
          traceId,
        );
      } catch (error) {
        // Fail-open is the point's contract; fail-SILENT is not (#606 audit):
        // a broken loader means the agent runs without AGENTS.md/skills and
        // someone must be able to see why. Non-Errors stay rethrown — an
        // exotic throw is a bug, not a degraded assembly.
        if (error instanceof Error) {
          Bus.publish(
            Operational.Events.Warn,
            Operational.envelope({
              traceId,
              component: "server.context",
              msg: "context assembly failed — run continues without it",
              context: { error: error.message },
            }),
          );
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
