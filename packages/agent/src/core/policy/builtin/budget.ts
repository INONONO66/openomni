import { PolicyDecision } from "@openomni/protocol";
import { checkBudget, describeBudgetRemaining } from "../../budget";
import type { PolicyFactory, PolicyRegistration } from "../types";

export function createBudgetReassurancePolicy(): PolicyRegistration {
  let issued = false;
  return {
    name: "builtin:budget-reassurance",
    timing: "turn.start",
    priority: 10,
    fn: (ctx) => {
      if (issued || !ctx.budgetState)
        return PolicyDecision.allow({ policyId: "builtin.budget.reassurance" });
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
        return PolicyDecision.allow({
          policyId: "builtin.budget.reassurance",
          reasonCodes: ["budget_reassurance"],
          effects: [
            {
              type: "prompt.inject_message",
              message: `[Budget Status] ${remaining}. You have plenty of budget remaining. Do NOT rush or skip tasks. Complete your work thoroughly.`,
            },
          ],
        });
      }
      return PolicyDecision.allow({ policyId: "builtin.budget.reassurance" });
    },
  };
}

export const budgetReassuranceFactory: PolicyFactory = {
  id: "policy:budget-reassurance",
  create: () => createBudgetReassurancePolicy(),
};

export function createBudgetWarningPolicy(): PolicyRegistration {
  let issued = false;
  return {
    name: "builtin:budget-warning",
    timing: "turn.start",
    priority: 20,
    fn: (ctx) => {
      if (issued || !ctx.budgetState)
        return PolicyDecision.allow({ policyId: "builtin.budget.warning" });
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
        return PolicyDecision.allow({
          policyId: "builtin.budget.warning",
          reasonCodes: ["budget_warning"],
          effects: [
            {
              type: "prompt.inject_message",
              message: `[Budget Warning] ${remaining}. Wrap up your current task and provide a summary.`,
            },
          ],
        });
      }
      return PolicyDecision.allow({ policyId: "builtin.budget.warning" });
    },
  };
}

export const budgetWarningFactory: PolicyFactory = {
  id: "policy:budget-warning",
  create: () => createBudgetWarningPolicy(),
};
