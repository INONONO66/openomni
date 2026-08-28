import { z } from "zod";
import { Events as EventDescriptors } from "../event/policy.js";
import { PolicyDefinition } from "./definition.js";
import { PolicyEffects } from "./effects.js";
import { PolicyPermission } from "./permission.js";
import { PolicyPointModule } from "./policy-point.js";
import { PolicyResource } from "./resource.js";

export { PolicyPermission } from "./permission.js";

export namespace Policy {
  export const LabelEntry = PolicyPermission.LabelEntry;
  export type LabelEntry = z.infer<typeof LabelEntry>;
  export const InputRule = PolicyPermission.InputRule;
  export type InputRule = z.infer<typeof InputRule>;
  export const Permission = PolicyPermission.Permission;
  export type Permission = z.infer<typeof Permission>;
  export const EvaluationRequest = PolicyPermission.EvaluationRequest;
  export type EvaluationRequest = z.infer<typeof EvaluationRequest>;
  export const EvaluationResult = PolicyPermission.EvaluationResult;
  export type EvaluationResult = z.infer<typeof EvaluationResult>;

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
  export type PolicyPoint = z.infer<typeof PolicyPointModule.PolicyPoint>;
  export type PolicyPointInputMap = PolicyPointModule.PolicyPointInputMap;

  /**
   * Runtime resource descriptors ride bus events; shape is wire-frozen.
   * Explicit member re-exports (not `export import`) so the members carry
   * direct references — the alias form hid every cross-package
   * `Policy.Resource.*` consumer from the dead-export ratchet (#498 K4).
   */
  export namespace Resource {
    export const Source = PolicyResource.Source;
    export type Source = PolicyResource.Source;
    export const Descriptor = PolicyResource.Descriptor;
    export type Descriptor = PolicyResource.Descriptor;
  }
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

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
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

  function create(
    verdict: Policy.PolicyDecision["verdict"],
    options: Options,
  ): Policy.PolicyDecision {
    return {
      policyId: options.policyId,
      verdict,
      effects: options.effects ?? [],
      reasonCodes: options.reasonCodes ?? [],
      ...(options.obligations !== undefined && { obligations: options.obligations }),
      ...(options.factsUsed !== undefined && { factsUsed: options.factsUsed }),
      ...(options.durationMs !== undefined && { durationMs: options.durationMs }),
      ...(options.priority !== undefined && { priority: options.priority }),
    };
  }

  export function allow(options: Options): Policy.PolicyDecision {
    return create("allow", options);
  }

  export function deny(options: Options): Policy.PolicyDecision {
    return create("deny", options);
  }

  export function pending(options: Options): Policy.PolicyDecision {
    return create("pending", options);
  }

  export function isBlocking(decision: Policy.PolicyDecision): boolean {
    return decision.verdict !== "allow";
  }

  export function reason(
    decision: Policy.PolicyDecision,
    fallback: string = decision.verdict,
  ): string {
    return decision.reasonCodes[0] ?? fallback;
  }
}
