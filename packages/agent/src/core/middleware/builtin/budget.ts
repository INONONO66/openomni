import { checkBudget, describeBudgetRemaining } from "../../budget";
import type { MiddlewareRegistration } from "../types";

export function createBudgetReassuranceMiddleware(): MiddlewareRegistration {
  let issued = false;
  return {
    name: "builtin:budget-reassurance",
    timing: "pre_turn",
    priority: 10,
    fn: (ctx) => {
      if (issued || !ctx.budgetState) return { action: "continue" };
      const status = checkBudget(ctx.budgetState, ctx.budget);
      if (status === "reassurance") {
        issued = true;
        const remaining = describeBudgetRemaining(ctx.budgetState, ctx.budget);
        ctx.eventEmitter?.emit("agent.budget.reassurance", {
          sessionId: "chat-agent",
          time: Date.now(),
          remaining,
          threshold: ctx.budget?.reassuranceThreshold ?? 0.6,
        });
        return {
          action: "inject",
          message: `[Budget Status] ${remaining}. You have plenty of budget remaining. Do NOT rush or skip tasks. Complete your work thoroughly.`,
        };
      }
      return { action: "continue" };
    },
  };
}

export function createBudgetWarningMiddleware(): MiddlewareRegistration {
  let issued = false;
  return {
    name: "builtin:budget-warning",
    timing: "pre_turn",
    priority: 20,
    fn: (ctx) => {
      if (issued || !ctx.budgetState) return { action: "continue" };
      const status = checkBudget(ctx.budgetState, ctx.budget);
      if (status === "warning") {
        issued = true;
        const remaining = describeBudgetRemaining(ctx.budgetState, ctx.budget);
        ctx.eventEmitter?.emit("agent.budget.warning", {
          sessionId: "chat-agent",
          time: Date.now(),
          remaining,
          threshold: ctx.budget?.warningThreshold ?? 0.8,
        });
        return {
          action: "inject",
          message: `[Budget Warning] ${remaining}. Wrap up your current task and provide a summary.`,
        };
      }
      return { action: "continue" };
    },
  };
}
