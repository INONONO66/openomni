import type { MiddlewareRegistration } from "../types";

export interface IdleNudgeConfig {
  idleThresholdMs?: number;
  maxNudges?: number;
}

export function createIdleNudgeMiddleware(config: IdleNudgeConfig = {}): MiddlewareRegistration {
  const idleThresholdMs = config.idleThresholdMs ?? 60000;
  const maxNudges = config.maxNudges ?? 3;

  let lastProgressAt = Date.now();
  let nudgeCount = 0;

  return {
    name: "builtin:idle-nudge",
    timing: ["pre_turn", "post_tool_use"],
    priority: 300,
    fn: (ctx) => {
      if (ctx.timing === "post_tool_use") {
        lastProgressAt = Date.now();
        return { action: "continue" };
      }

      if (idleThresholdMs === -1) return { action: "continue" };

      const idleMs = Date.now() - lastProgressAt;
      if (idleMs <= idleThresholdMs) return { action: "continue" };

      if (nudgeCount >= maxNudges) {
        return { action: "abort", reason: "stalled" };
      }

      nudgeCount++;
      lastProgressAt = Date.now();

      const idleSecs = Math.round(idleMs / 1000);
      return {
        action: "inject",
        message: `[System] You have been idle for ${idleSecs}s. Report your current status: what are you working on, what is blocking you, and what is your next action. If you are stuck, say so explicitly.`,
      };
    },
  };
}
