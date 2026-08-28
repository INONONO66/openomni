import { z } from "zod";

export namespace PolicyEffects {
  type JsonPlainValue =
    | null
    | boolean
    | number
    | string
    | JsonPlainValue[]
    | { readonly [key: string]: JsonPlainValue };

  function isJsonPlainValue(value: unknown): value is JsonPlainValue {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
    if (Array.isArray(value)) {
      // Dense-array proof without own-property probes: a JSON-plain array's
      // enumerable keys are exactly the canonical indices "0".."n-1". This
      // also refuses the cancellation shape (one hole + one named property)
      // that a bare keys-count comparison would admit.
      const keys = Object.keys(value);
      return (
        keys.length === value.length &&
        keys.every((key, index) => key === String(index)) &&
        value.every((item) => isJsonPlainValue(item))
      );
    }
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      return false;
    const object = value as Record<string, unknown>;
    return Object.keys(object).every(
      (key) =>
        !["__proto__", "constructor", "prototype"].includes(key) && isJsonPlainValue(object[key]),
    );
  }

  const JsonPlainObject = z.custom<Record<string, unknown>>(
    (value): value is Record<string, unknown> =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      isJsonPlainValue(value),
    { message: "Expected a JSON-plain object" },
  );
  const JsonPlainArray = z.custom<unknown[]>(
    (value): value is unknown[] => Array.isArray(value) && isJsonPlainValue(value),
    { message: "Expected a JSON-plain array" },
  );

  export const PolicyEffectType = z.enum([
    "prompt.append_context",
    "prompt.inject_message",
    "prompt.replace",
    "tool.filter",
    "tool.rewrite_input",
    "tool.rewrite_output",
    "tool.skip_invocation",
    "tool.require_approval",
    "run.abort",
    "run.continue_with_prompt",
    "run.retry_after",
    "run.replace_messages",
    "delegation.set_constraints",
    "delegation.require_approval",
    "audit.annotate",
    "writeback.rewrite",
    "writeback.suppress",
    "runtime.set_timeout",
    "runtime.workspace_lock",
    "work.allow_asserted",
    "model.override",
  ]);
  export type PolicyEffectType = z.infer<typeof PolicyEffectType>;

  export const PolicyEffect = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("prompt.append_context"),
      context: z.string(),
    }),
    z.object({
      type: z.literal("prompt.inject_message"),
      message: z.string(),
      role: z.enum(["user", "assistant"]).optional(),
    }),
    z.object({
      type: z.literal("prompt.replace"),
      prompt: z.string(),
    }),
    z.object({
      type: z.literal("tool.filter"),
      toolPattern: z.string(),
    }),
    z.object({
      type: z.literal("tool.rewrite_input"),
      input: JsonPlainObject,
    }),
    z.object({
      type: z.literal("tool.rewrite_output"),
      output: z.string(),
    }),
    z.object({
      type: z.literal("tool.skip_invocation"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("tool.require_approval"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("run.abort"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("run.continue_with_prompt"),
      prompt: z.string(),
    }),
    z.object({
      type: z.literal("run.retry_after"),
      delayMs: z.number().int().min(0),
      maxRetries: z.number().int().min(1).optional(),
    }),
    z.object({
      type: z.literal("run.replace_messages"),
      messages: JsonPlainArray,
    }),
    z.object({
      type: z.literal("delegation.set_constraints"),
      constraints: JsonPlainObject,
    }),
    z.object({
      type: z.literal("delegation.require_approval"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("audit.annotate"),
      annotation: z.string(),
      severity: z.enum(["info", "warning", "error"]).optional(),
    }),
    z.object({
      type: z.literal("writeback.rewrite"),
      output: z.string(),
    }),
    z.object({
      type: z.literal("writeback.suppress"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("runtime.set_timeout"),
      timeoutMs: z.number().int().min(0),
    }),
    z.object({
      type: z.literal("runtime.workspace_lock"),
      required: z.boolean(),
    }),
    z.object({
      type: z.literal("work.allow_asserted"),
      criterionIds: z.array(z.string().min(1)),
    }),
    // Per-point model routing (#753): reroutes the CONNECTION being gated at
    // `connection.llm.pre` to a different model — connection-scoped by
    // definition (the next connection re-resolves normally; a policy that
    // wants the whole run re-issues the effect per connection, which per-run
    // factory registrations make trivial). A run-scoped variant is deferred
    // to #753 follow-up scope.
    z.object({
      type: z.literal("model.override"),
      provider: z.string().min(1),
      id: z.string().min(1),
    }),
  ]);
  export type PolicyEffect = z.infer<typeof PolicyEffect>;

  export const PolicyObligation = z.object({
    obligationId: z.string(),
    type: z.enum(["humanApproval", "evidenceRequired", "credentialConfirm"]),
    description: z.string(),
    timeoutMs: z.number().int().min(0).optional(),
    resolvedBy: z.string().optional(),
  });
  export type PolicyObligation = z.infer<typeof PolicyObligation>;

  export const PolicyDecision = z
    .object({
      policyId: z.string(),
      policyVersion: z.string().optional(),
      verdict: z.enum(["allow", "deny", "pending"]),
      effects: z.array(PolicyEffect),
      obligations: z.array(PolicyObligation).optional(),
      reasonCodes: z.array(z.string()),
      factsUsed: z.array(z.string()).optional(),
      durationMs: z.number().min(0).optional(),
      priority: z.number().optional(),
    })
    .strict();
  export type PolicyDecision = z.infer<typeof PolicyDecision>;

  export const EffectiveDecision = z.object({
    verdict: z.enum(["allow", "deny", "pending"]),
    mergedEffects: z.array(PolicyEffect),
    obligations: z.array(PolicyObligation),
    contributingPolicies: z.array(z.string()),
  });
  export type EffectiveDecision = z.infer<typeof EffectiveDecision>;
}
