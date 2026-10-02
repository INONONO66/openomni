import type { z } from "zod";
import { PolicyEffects } from "./effects.js";
import { PolicyPermission } from "./permission.js";
import { PolicyResource } from "./resource.js";

export { PolicyPermission } from "./permission.js";

export namespace Policy {
  export const Permission = PolicyPermission.Permission;
  export type Permission = z.infer<typeof Permission>;
  export const EvaluationRequest = PolicyPermission.EvaluationRequest;
  export type EvaluationRequest = z.infer<typeof EvaluationRequest>;
  export const EvaluationResult = PolicyPermission.EvaluationResult;
  export type EvaluationResult = z.infer<typeof EvaluationResult>;

  export const PolicyEffect = PolicyEffects.PolicyEffect;
  export type PolicyEffect = z.infer<typeof PolicyEffect>;
  export const PolicyDecision = PolicyEffects.PolicyDecision;
  export type PolicyDecision = z.infer<typeof PolicyDecision>;

  /**
   * Runtime resource descriptors ride bus events; shape is wire-frozen.
   * Explicit member re-exports (not `export import`) so the members carry
   * direct references — the alias form hid every cross-package
   * `Policy.Resource.*` consumer from the dead-export ratchet (#498 K4).
   */
  export namespace Resource {
    export const Descriptor = PolicyResource.Descriptor;
    export type Descriptor = PolicyResource.Descriptor;
  }
}

export type PolicyDecision = Policy.PolicyDecision;

export namespace PolicyDecision {
  export interface Options {
    readonly policyId: string;
    readonly effects?: Policy.PolicyEffect[];
    readonly reasonCodes?: string[];
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

  export function reason(
    decision: Policy.PolicyDecision,
    fallback: string = decision.verdict,
  ): string {
    return decision.reasonCodes[0] ?? fallback;
  }
}
