import { z } from "zod";

export const policyKernelVersion = 1;

export namespace PolicyDefinition {
  export const Timing = {
    DISPATCH_AUTHORIZE: "dispatch.authorize",
    RUN_START: "run.start",
    TURN_START: "turn.start",
    CONTEXT_PREPARE: "context.prepare",
    RESOURCES_PREPARE: "resources.prepare",
    MODEL_REQUEST: "model.request",
    MODEL_RESPONSE: "model.response",
    INVOKE_PREPARE: "invoke.prepare",
    INVOKE_RESULT: "invoke.result",
    TURN_FINISH: "turn.finish",
    COMPLETION_PREPARE: "completion.prepare",
    RUN_FINISH: "run.finish",
    ERROR: "error",
  } as const;

  export type Timing = (typeof Timing)[keyof typeof Timing];
  const TimingValue = z.nativeEnum(Timing);

  export const Scope = z.object({
    agentType: z.array(z.string()).optional(),
  });
  export type Scope = z.infer<typeof Scope>;

  export const FailPolicy = z.enum(["fail-open", "fail-closed"]);
  export type FailPolicy = z.infer<typeof FailPolicy>;

  export const Definition = z.object({
    name: z.string().min(1),
    timing: z.union([TimingValue, z.array(TimingValue)]),
    priority: z.number().int().min(0),
    scope: Scope.optional(),
    failPolicy: FailPolicy.optional(),
  });
  export type Definition = z.infer<typeof Definition>;
}
