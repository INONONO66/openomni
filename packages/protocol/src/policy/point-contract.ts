import { z } from "zod";
import { PolicyDefinition } from "./definition.js";
import { PolicyEffects } from "./effects.js";

export namespace PolicyPointContractModule {
  export const Timing = PolicyDefinition.Timing;
  export type Timing = PolicyDefinition.Timing;
  const FailPolicy = PolicyDefinition.FailPolicy;
  const PolicyEffectType = PolicyEffects.PolicyEffectType;
  type PolicyEffectType = PolicyEffects.PolicyEffectType;
  const TimingValue = z.nativeEnum(Timing);

  const policyPointIds = [
    "dispatch.action.pre",
    "run.lifecycle.pre",
    "run.turn.pre",
    "prompt.context.pre",
    "tool.catalog.pre",
    "connection.llm.pre",
    "connection.llm.post",
    "tool.native.pre",
    "tool.mcp.pre",
    "delegation.worker.pre",
    "tool.native.post",
    "tool.mcp.post",
    "delegation.worker.post",
    "run.turn.post",
    "run.completion.pre",
    "work.complete.pre",
    "run.lifecycle.post",
    "run.error.error",
  ] as const;

  // Adding a registered policy point intentionally touches this ID list, the
  // registry entry, and the migration mapping so schema, contract, and legacy
  // timing compatibility remain reviewable in one protocol-layer change.
  export const policyPoint = z.object({
    point: TimingValue,
    allowedEffects: z.array(PolicyEffectType),
    defaultFailPolicy: FailPolicy,
  });

  export type RegisteredPolicyPointId = (typeof policyPointIds)[number];

  export const PolicyPointId = z
    .string()
    .regex(
      /^(tool|prompt|delegation|session|credential|connection|run|dispatch|work)\.[a-z][a-z0-9-]*\.(pre|post|error)$/,
    );
  export const PolicyPointContract = z.object({
    id: PolicyPointId,
    version: z.number().int().min(1),
    phase: z.enum(["pre", "post", "error"]),
    resourceKinds: z.array(z.string()),
    inputSchema: z.string(),
    requiredContext: z.array(z.string()),
    allowedEffects: z.array(PolicyEffectType),
    defaultFailPolicy: FailPolicy,
    sideEffectBoundary: z.boolean(),
  });
  export type PolicyPointContract = z.infer<typeof PolicyPointContract>;
  export type PolicyPointContractSnapshot = Readonly<
    Omit<PolicyPointContract, "resourceKinds" | "requiredContext" | "allowedEffects"> & {
      readonly resourceKinds: readonly string[];
      readonly requiredContext: readonly string[];
      readonly allowedEffects: readonly PolicyEffectType[];
    }
  >;

  export const contract = (
    id: RegisteredPolicyPointId,
    phase: PolicyPointContract["phase"],
    resourceKinds: readonly string[],
    requiredContext: readonly string[],
    allowedEffects: readonly PolicyEffectType[],
    defaultFailPolicy: PolicyPointContract["defaultFailPolicy"],
    sideEffectBoundary: boolean,
  ): PolicyPointContractSnapshot =>
    Object.freeze({
      id,
      version: 1,
      phase,
      resourceKinds: Object.freeze([...resourceKinds]),
      inputSchema: `policy.point.${id}.input.v1`,
      requiredContext: Object.freeze([...requiredContext]),
      allowedEffects: Object.freeze([...allowedEffects]),
      defaultFailPolicy,
      sideEffectBoundary,
    });

  export const preBoundary = ["fail-closed", true] as const;
  export const postBoundary = ["fail-open", false] as const;
}
