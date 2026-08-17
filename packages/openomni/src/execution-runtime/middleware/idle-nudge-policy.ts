import { PolicyDecision } from "@openomni/protocol";
import { z } from "zod";
import { RunReasonCode } from "@openomni/agent";
import type {
  CanonicalPolicyRegistration,
  PolicyRegistrationFactory,
  PolicyRegistryInstance,
  PolicyContext,
} from "@openomni/agent";

export interface IdleNudgeConfig {
  idleThresholdMs?: number;
  maxNudges?: number;
}

/**
 * Per-run factory: the idle clock and nudge counter are run state, minted by
 * `create()` once per policy engine (one engine per run). A shared instance
 * raced these counters across the parent run and every child agent reusing
 * the same middleware array; the old turnCount-reset heuristic that tried to
 * detect "a new run" inside one closure is gone with the sharing.
 *
 * Progress is any forward observable step: a completed tool invocation
 * (`invoke.result`) or the run advancing to a new turn (the previous turn
 * completed — text-only turns included). Only a run re-entering the SAME turn
 * without advancing (retry storms, stop loops) accrues idleness, so a healthy
 * multi-turn text-only run is never nudged or aborted (#audit H2).
 */
export function createIdleNudgePolicy(config: IdleNudgeConfig = {}): PolicyRegistrationFactory {
  const idleThresholdMs = config.idleThresholdMs ?? 60000;
  const maxNudges = config.maxNudges ?? 3;

  return {
    kind: "factory",
    name: "builtin:idle-nudge",
    create: (): CanonicalPolicyRegistration => {
      let lastProgressAt = Date.now();
      let nudgeCount = 0;
      let lastTurnCount: number | undefined;

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

          // A turn advance means the previous turn completed — forward
          // progress even when it produced only text. The first observation
          // records the baseline without claiming progress: the clock already
          // started when the run built this policy.
          if (lastTurnCount !== undefined && ctx.turnCount > lastTurnCount) {
            lastProgressAt = Date.now();
            nudgeCount = 0;
          }
          lastTurnCount = ctx.turnCount;

          if (idleThresholdMs === -1)
            return PolicyDecision.allow({ policyId: "builtin.idle_nudge" });

          const idleMs = Date.now() - lastProgressAt;
          if (idleMs < idleThresholdMs)
            return PolicyDecision.allow({ policyId: "builtin.idle_nudge" });

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
                // Honest about the consequence: what resets the idle clock is
                // observable progress (a completed tool call or a completed
                // turn), and a run that keeps accruing idleness is aborted as
                // stalled after the nudge budget — not saved by saying so.
                message: `[System] You have been idle for ${idleSecs}s. Report your current status: what are you working on, what is blocking you, and what is your next action. Only observable progress (a completed tool call or turn) resets this check; after ${maxNudges} nudges with no progress the run is aborted as stalled.`,
              },
            ],
          });
        },
      };
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
