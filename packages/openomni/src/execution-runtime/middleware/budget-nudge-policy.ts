import { PolicyDecision } from "@openomni/protocol";
import {
  checkBudget,
  describeBudgetRemaining,
  type CanonicalPolicyRegistration,
  type PolicyContext,
  type PolicyRegistryInstance,
} from "@openomni/agent";

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

/**
 * Registers the two budget nudges. The core owns budget *accounting* — the
 * limits are loop invariants and `checkBudget` is its query — but telling the
 * model how much room it has left is an opinion about how to talk to a model,
 * which is a product's call (D5).
 */
export function registerBudgetNudges(registry: PolicyRegistryInstance<PolicyContext>): void {
  registry.register("builtin:budget-reassurance", () => createBudgetReassurancePolicy());
  registry.register("builtin:budget-warning", () => createBudgetWarningPolicy());
}
