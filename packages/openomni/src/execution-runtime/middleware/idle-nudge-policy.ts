import { PolicyDecision } from "@openomni/protocol";
import { z } from "zod";
import { RunReasonCode } from "@openomni/agent";
import type {
  CanonicalPolicyRegistration,
  PolicyRegistryInstance,
  PolicyContext,
} from "@openomni/agent";

export interface IdleNudgeConfig {
  idleThresholdMs?: number;
  maxNudges?: number;
}

export function createIdleNudgePolicy(config: IdleNudgeConfig = {}): CanonicalPolicyRegistration {
  const idleThresholdMs = config.idleThresholdMs ?? 60000;
  const maxNudges = config.maxNudges ?? 3;

  let lastProgressAt = Date.now();
  let nudgeCount = 0;
  let lastTurnCount = -1;

  return {
    name: "builtin:idle-nudge",
    kind: "point",
    pointIds: ["run.turn.pre", "tool.native.post", "tool.mcp.post"],
    effectCapabilities: {
      "run.turn.pre": ["prompt.inject_message", "run.abort"],
      "tool.native.post": [],
      "tool.mcp.post": [],
    },
    priority: 300,
    fn: (ctx) => {
      if (ctx.timing === "invoke.result") {
        lastProgressAt = Date.now();
        return PolicyDecision.allow({ policyId: "builtin.idle_nudge" });
      }

      // detect new agent run: turnCount resets to 0
      if (ctx.turnCount === 0 && lastTurnCount > 0) {
        lastProgressAt = Date.now();
        nudgeCount = 0;
      }
      lastTurnCount = ctx.turnCount;

      if (idleThresholdMs === -1) return PolicyDecision.allow({ policyId: "builtin.idle_nudge" });

      const idleMs = Date.now() - lastProgressAt;
      if (idleMs < idleThresholdMs) return PolicyDecision.allow({ policyId: "builtin.idle_nudge" });

      if (nudgeCount >= maxNudges) {
        return PolicyDecision.deny({
          policyId: "builtin.idle_nudge",
          reasonCodes: [RunReasonCode.Stalled],
          effects: [{ type: "run.abort", reason: RunReasonCode.Stalled }],
        });
      }

      nudgeCount++;
      lastProgressAt = Date.now();

      const idleSecs = Math.round(idleMs / 1000);
      return PolicyDecision.allow({
        policyId: "builtin.idle_nudge",
        reasonCodes: ["idle_nudge"],
        effects: [
          {
            type: "prompt.inject_message",
            message: `[System] You have been idle for ${idleSecs}s. Report your current status: what are you working on, what is blocking you, and what is your next action. If you are stuck, say so explicitly.`,
          },
        ],
      });
    },
  };
}

const IdleNudgeConfigSchema: z.ZodType<IdleNudgeConfig, z.ZodTypeDef, unknown> = z.object({
  idleThresholdMs: z.number().optional(),
  maxNudges: z.number().optional(),
});

/**
 * Registers the idle nudge, which is an opinion rather than a loop invariant
 * (D5): a run that has not progressed is still a valid run, and only a product
 * decides that prodding it is the right response. The core ships the point;
 * this ships the policy.
 */
export function registerIdleNudge(registry: PolicyRegistryInstance<PolicyContext>): void {
  registry.register("builtin:idle-nudge", (config) =>
    createIdleNudgePolicy(IdleNudgeConfigSchema.parse(config ?? {})),
  );
}
