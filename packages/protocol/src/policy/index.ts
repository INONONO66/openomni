import { z } from "zod";
import { PolicyDecisionHelpers } from "./decision.js";
import { PolicyDefinition } from "./definition.js";
import { PolicyEffects } from "./effects.js";
import { PolicyPermission } from "./permission.js";
import { PolicyPointModule } from "./policy-point.js";

export { RuntimeResource } from "./resource.js";
export { policyKernelVersion } from "./definition.js";

export namespace Policy {
  export const Label = PolicyPermission.Label;
  export type Label = {
    Source: z.infer<typeof Label.Source>;
  };
  export const LabelEntry = PolicyPermission.LabelEntry;
  export type LabelEntry = z.infer<typeof LabelEntry>;
  export const PermissionDecision = PolicyPermission.PermissionDecision;
  export type PermissionDecision = z.infer<typeof PermissionDecision>;
  export const InputRule = PolicyPermission.InputRule;
  export type InputRule = z.infer<typeof InputRule>;
  export const Permission = PolicyPermission.Permission;
  export type Permission = z.infer<typeof Permission>;
  export const EvaluationRequest = PolicyPermission.EvaluationRequest;
  export type EvaluationRequest = z.infer<typeof EvaluationRequest>;
  export const EvaluationResult = PolicyPermission.EvaluationResult;
  export type EvaluationResult = z.infer<typeof EvaluationResult>;
  export const evaluate = PolicyPermission.evaluate;

  export const Timing = PolicyDefinition.Timing;
  export type Timing = (typeof Timing)[keyof typeof Timing];
  export const Scope = PolicyDefinition.Scope;
  export type Scope = z.infer<typeof Scope>;
  export const FailPolicy = PolicyDefinition.FailPolicy;
  export type FailPolicy = z.infer<typeof FailPolicy>;
  export const Definition = PolicyDefinition.Definition;
  export type Definition = z.infer<typeof Definition>;

  export const PolicyEffectType = PolicyEffects.PolicyEffectType;
  export type PolicyEffectType = z.infer<typeof PolicyEffectType>;
  export const PolicyEffect = PolicyEffects.PolicyEffect;
  export type PolicyEffect = z.infer<typeof PolicyEffect>;
  export const PolicyObligation = PolicyEffects.PolicyObligation;
  export type PolicyObligation = z.infer<typeof PolicyObligation>;
  export const PolicyDecision = PolicyEffects.PolicyDecision;
  export type PolicyDecision = z.infer<typeof PolicyDecision>;
  export const EffectiveDecision = PolicyEffects.EffectiveDecision;
  export type EffectiveDecision = z.infer<typeof EffectiveDecision>;

  export const PolicyPoint = PolicyPointModule.PolicyPoint;
  export type PolicyPoint = z.infer<typeof PolicyPointModule.PolicyPoint> &
    Pick<typeof PolicyPointModule.PolicyPoint, "MigrationMapping">;
  export type PolicyPointInputMap = PolicyPointModule.PolicyPointInputMap;
  export const PolicyPlan = z.object({
    policies: z.array(
      z.object({
        id: z.string().min(1),
        required: z.boolean(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    labels: z.array(z.string()),
    registryVersion: z.string().optional(),
  });
  export type PolicyPlan = z.infer<typeof PolicyPlan>;
}

export type PolicyDecision = Policy.PolicyDecision;

export namespace PolicyDecision {
  export interface Options {
    readonly policyId: string;
    readonly effects?: Policy.PolicyEffect[];
    readonly reasonCodes?: string[];
    readonly obligations?: Policy.PolicyObligation[];
    readonly factsUsed?: string[];
    readonly durationMs?: number;
    readonly priority?: number;
  }

  export function allow(options: Options): Policy.PolicyDecision {
    return PolicyDecisionHelpers.allow(options);
  }

  export function deny(options: Options): Policy.PolicyDecision {
    return PolicyDecisionHelpers.deny(options);
  }

  export function pending(options: Options): Policy.PolicyDecision {
    return PolicyDecisionHelpers.pending(options);
  }

  export function isBlocking(decision: Policy.PolicyDecision): boolean {
    return PolicyDecisionHelpers.isBlocking(decision);
  }

  export function reason(
    decision: Policy.PolicyDecision,
    fallback: string = decision.verdict,
  ): string {
    return PolicyDecisionHelpers.reason(decision, fallback);
  }

  export function fromEvaluation(
    result: Policy.EvaluationResult,
    options: { readonly policyId?: string; readonly denyEffect?: Policy.PolicyEffect } = {},
  ): Policy.PolicyDecision {
    return PolicyDecisionHelpers.fromEvaluation(result, options);
  }
}
