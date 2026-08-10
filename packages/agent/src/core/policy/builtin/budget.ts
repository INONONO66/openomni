import { PolicyDecision } from "@openomni/protocol";
import { checkBudget, describeBudgetRemaining, effectiveBudgetThresholds } from "../../budget";
import type { CanonicalPolicyRegistration } from "../types";

export function createBudgetReassurancePolicy(): CanonicalPolicyRegistration {
  let issued = false;
  return {
    name: "builtin:budget-reassurance",
    kind: "point",
    pointIds: ["run.turn.pre"],
    effectCapabilities: { "run.turn.pre": ["prompt.inject_message"] },
    priority: 10,
    fn: (ctx) => {
      if (issued || !ctx.budgetState)
        return PolicyDecision.allow({ policyId: "builtin.budget.reassurance" });
      const status = checkBudget(ctx.budgetState, ctx.budget);
      if (status === "reassurance") {
        issued = true;
        const remaining = describeBudgetRemaining(ctx.budgetState, ctx.budget);
        // run.turn.pre contract guarantees a non-empty sessionId on every
        // canonical dispatch; "" only surfaces on a non-contract invocation.
        ctx.eventEmitter?.emit("agent.budget.reassurance", {
          sessionId: ctx.sessionId ?? "",
          time: Date.now(),
          remaining,
          threshold: effectiveBudgetThresholds(ctx.budget).reassuranceThreshold,
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

export function createBudgetWarningPolicy(): CanonicalPolicyRegistration {
  let issued = false;
  return {
    name: "builtin:budget-warning",
    kind: "point",
    pointIds: ["run.turn.pre"],
    effectCapabilities: { "run.turn.pre": ["prompt.inject_message"] },
    priority: 20,
    fn: (ctx) => {
      if (issued || !ctx.budgetState)
        return PolicyDecision.allow({ policyId: "builtin.budget.warning" });
      const status = checkBudget(ctx.budgetState, ctx.budget);
      if (status === "warning") {
        issued = true;
        const remaining = describeBudgetRemaining(ctx.budgetState, ctx.budget);
        // run.turn.pre contract guarantees a non-empty sessionId on every
        // canonical dispatch; "" only surfaces on a non-contract invocation.
        ctx.eventEmitter?.emit("agent.budget.warning", {
          sessionId: ctx.sessionId ?? "",
          time: Date.now(),
          remaining,
          threshold: effectiveBudgetThresholds(ctx.budget).warningThreshold,
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
