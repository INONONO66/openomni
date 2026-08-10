import { PolicyDecision } from "@openomni/protocol";
import { checkBudget, describeBudgetRemaining, effectiveBudgetThresholds } from "../../budget";
import type { CanonicalPolicyRegistration } from "../types";

/**
 * The run.turn.pre point contract requires a non-empty sessionId, so a
 * canonical dispatch always carries the real id; the type just doesn't
 * surface it on the agent PolicyContext.
 */
function contextSessionId(ctx: object): string {
  const sessionId = Reflect.get(ctx, "sessionId");
  return typeof sessionId === "string" ? sessionId : "";
}

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
        ctx.eventEmitter?.emit("agent.budget.reassurance", {
          sessionId: contextSessionId(ctx),
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
        ctx.eventEmitter?.emit("agent.budget.warning", {
          sessionId: contextSessionId(ctx),
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
