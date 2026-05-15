import { PolicyDecision } from "@openomni/protocol";
import type { PolicyFactory, PolicyRegistration } from "../types";

export interface IdleNudgeConfig {
  idleThresholdMs?: number;
  maxNudges?: number;
}

export function createIdleNudgePolicy(config: IdleNudgeConfig = {}): PolicyRegistration {
  const idleThresholdMs = config.idleThresholdMs ?? 60000;
  const maxNudges = config.maxNudges ?? 3;

  let lastProgressAt = Date.now();
  let nudgeCount = 0;
  let lastTurnCount = -1;

  return {
    name: "builtin:idle-nudge",
    timing: ["turn.start", "invoke.result"],
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
      if (idleMs <= idleThresholdMs)
        return PolicyDecision.allow({ policyId: "builtin.idle_nudge" });

      if (nudgeCount >= maxNudges) {
        return PolicyDecision.deny({
          policyId: "builtin.idle_nudge",
          reasonCodes: ["stalled"],
          effects: [{ type: "run.abort", reason: "stalled" }],
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

export const idleNudgeFactory: PolicyFactory = {
  id: "policy:idle-nudge",
  create: (config) => createIdleNudgePolicy(config as IdleNudgeConfig),
};
