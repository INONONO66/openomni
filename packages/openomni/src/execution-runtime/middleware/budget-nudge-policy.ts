import { PolicyDecision } from "@openomni/protocol";
import {
  RunReasonCode,
  checkBudget,
  describeBudgetRemaining,
  type CanonicalPolicyRegistration,
  type PolicyContext,
  type PolicyRegistrationFactory,
  type PolicyRegistryInstance,
} from "@openomni/agent";

/**
 * Both nudges carry per-run state (`issued`), so both are per-run factories:
 * the agent's policy engine calls `create()` once per run it is built for.
 * Returning a plain registration here shared one `issued` flag across every
 * run and every parent/child agent that reused the middleware array — the
 * warning fired once per middleware ASSEMBLY instead of once per run.
 */
export function createBudgetReassurancePolicy(): PolicyRegistrationFactory {
  return {
    kind: "factory",
    name: "builtin:budget-reassurance",
    create: (): CanonicalPolicyRegistration => {
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
              reasonCodes: [RunReasonCode.BudgetReassurance],
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
    },
  };
}

export function createBudgetWarningPolicy(): PolicyRegistrationFactory {
  return {
    kind: "factory",
    name: "builtin:budget-warning",
    create: (): CanonicalPolicyRegistration => {
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
              reasonCodes: [RunReasonCode.BudgetWarning],
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
