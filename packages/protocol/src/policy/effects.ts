import { z } from "zod";
import { isPlainValue, type PlainObject, type PlainValue } from "../json.js";

export namespace PolicyEffects {
  // Named generic guards: z.custom's inline callback parameter would be
  // contextually typed `unknown`; a generic parameter carries no top type.
  function isJsonPlainObject<Input>(value: Input): boolean {
    return (
      typeof value === "object" && value !== null && !Array.isArray(value) && isPlainValue(value)
    );
  }
  function isJsonPlainArray<Input>(value: Input): boolean {
    return Array.isArray(value) && isPlainValue(value);
  }
  const JsonPlainObject = z.custom<PlainObject>(isJsonPlainObject, {
    message: "Expected a JSON-plain object",
  });
  const JsonPlainArray = z.custom<PlainValue[]>(isJsonPlainArray, {
    message: "Expected a JSON-plain array",
  });

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

  export const PolicyDecision = z
    .object({
      policyId: z.string(),
      policyVersion: z.string().optional(),
      verdict: z.enum(["allow", "deny", "pending"]),
      effects: z.array(PolicyEffect),
      reasonCodes: z.array(z.string()),
      factsUsed: z.array(z.string()).optional(),
      durationMs: z.number().min(0).optional(),
      priority: z.number().optional(),
    })
    .strict();
  export type PolicyDecision = z.infer<typeof PolicyDecision>;
}
