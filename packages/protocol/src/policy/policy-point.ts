import { z } from "zod";
import { PolicyDefinition, policyKernelVersion } from "./definition.js";
import { PolicyEffects } from "./effects.js";

// Module-internal alias: the engine consumers that used to reach this via
// the namespace moved to packages/policy (#498 W1) and read Policy.Timing;
// only TimingValue below needs it here.
const Timing = PolicyDefinition.Timing;
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
// registry entry, and the input validator below so schema and contract
// remain reviewable in one protocol-layer change.
const policyPoint = z.object({
  point: TimingValue,
  allowedEffects: z.array(PolicyEffectType),
  defaultFailPolicy: FailPolicy,
});

type RegisteredPolicyPointId = (typeof policyPointIds)[number];

const PolicyPointId = z
  .string()
  .regex(
    /^(tool|prompt|delegation|session|credential|connection|run|dispatch|work)\.[a-z][a-z0-9-]*\.(pre|post|error)$/,
  );
const PolicyPointContract = z.object({
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
type PolicyPointContract = z.infer<typeof PolicyPointContract>;
type PolicyPointContractSnapshot = Readonly<
  Omit<PolicyPointContract, "resourceKinds" | "requiredContext" | "allowedEffects"> & {
    readonly resourceKinds: readonly string[];
    readonly requiredContext: readonly string[];
    readonly allowedEffects: readonly PolicyEffectType[];
  }
>;

const contract = (
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

const preBoundary = ["fail-closed", true] as const;
const postBoundary = ["fail-open", false] as const;

const PolicyPointRegistry = Object.freeze({
  "dispatch.action.pre": contract(
    "dispatch.action.pre",
    "pre",
    ["dispatch"],
    ["actor", "dispatchId", "action", "target"],
    ["audit.annotate", "run.abort"],
    ...preBoundary,
  ),
  "run.lifecycle.pre": contract(
    "run.lifecycle.pre",
    "pre",
    ["run"],
    ["actorId", "sessionId", "runId"],
    [
      "audit.annotate",
      "run.abort",
      "delegation.set_constraints",
      "prompt.append_context",
      "prompt.inject_message",
    ],
    ...preBoundary,
  ),
  "run.turn.pre": contract(
    "run.turn.pre",
    "pre",
    ["run"],
    ["sessionId", "runId", "turnIndex"],
    [
      "audit.annotate",
      "run.abort",
      "run.retry_after",
      "prompt.append_context",
      "prompt.inject_message",
    ],
    ...preBoundary,
  ),
  "prompt.context.pre": contract(
    "prompt.context.pre",
    "pre",
    ["prompt"],
    ["sessionId", "runId", "turnIndex"],
    ["prompt.append_context", "prompt.inject_message", "prompt.replace", "audit.annotate"],
    // Prompt context policy is advisory: failure should not block the run,
    // but it still marks a side-effect boundary because it can rewrite prompt input.
    "fail-open",
    true,
  ),
  "tool.catalog.pre": contract(
    "tool.catalog.pre",
    "pre",
    ["tool"],
    ["sessionId", "runId", "availableTools"],
    ["tool.filter", "audit.annotate", "run.abort"],
    ...preBoundary,
  ),
  "connection.llm.pre": contract(
    "connection.llm.pre",
    "pre",
    ["connection"],
    ["sessionId", "runId", "modelId"],
    [
      "prompt.append_context",
      "prompt.inject_message",
      "run.abort",
      "audit.annotate",
      "model.override",
    ],
    ...preBoundary,
  ),
  "connection.llm.post": contract(
    "connection.llm.post",
    "post",
    ["connection"],
    ["sessionId", "runId", "modelId", "responseTokens"],
    ["audit.annotate", "run.abort", "prompt.inject_message", "run.replace_messages"],
    ...postBoundary,
  ),
  "tool.native.pre": contract(
    "tool.native.pre",
    "pre",
    ["tool"],
    ["sessionId", "runId", "toolId", "toolInput"],
    [
      "tool.filter",
      "tool.rewrite_input",
      "tool.skip_invocation",
      "tool.require_approval",
      "run.abort",
      "audit.annotate",
    ],
    ...preBoundary,
  ),
  "tool.mcp.pre": contract(
    "tool.mcp.pre",
    "pre",
    ["tool"],
    ["sessionId", "runId", "toolId", "mcpServerId", "toolInput"],
    [
      "tool.filter",
      "tool.rewrite_input",
      "tool.skip_invocation",
      "tool.require_approval",
      "run.abort",
      "audit.annotate",
    ],
    ...preBoundary,
  ),
  "delegation.worker.pre": contract(
    "delegation.worker.pre",
    "pre",
    ["worker"],
    ["sessionId", "runId", "workerRunId", "workerProfile"],
    ["delegation.set_constraints", "delegation.require_approval", "run.abort", "audit.annotate"],
    ...preBoundary,
  ),
  "tool.native.post": contract(
    "tool.native.post",
    "post",
    ["tool"],
    ["sessionId", "runId", "toolId", "toolResult"],
    ["audit.annotate", "run.abort", "tool.rewrite_output"],
    ...postBoundary,
  ),
  "tool.mcp.post": contract(
    "tool.mcp.post",
    "post",
    ["tool"],
    ["sessionId", "runId", "toolId", "mcpServerId", "toolResult"],
    ["audit.annotate", "run.abort", "tool.rewrite_output"],
    ...postBoundary,
  ),
  "delegation.worker.post": contract(
    "delegation.worker.post",
    "post",
    ["worker"],
    ["sessionId", "runId", "workerRunId", "workerResult"],
    ["audit.annotate"],
    ...postBoundary,
  ),
  "run.turn.post": contract(
    "run.turn.post",
    "post",
    ["run"],
    ["sessionId", "runId", "turnIndex", "turnResult"],
    [
      "audit.annotate",
      "run.abort",
      "run.continue_with_prompt",
      "prompt.inject_message",
      "run.replace_messages",
    ],
    ...postBoundary,
  ),
  "run.completion.pre": contract(
    "run.completion.pre",
    "pre",
    ["run"],
    ["sessionId", "runId", "completionCandidate"],
    ["audit.annotate", "run.abort", "prompt.append_context", "run.replace_messages"],
    ...preBoundary,
  ),
  "work.complete.pre": contract(
    "work.complete.pre",
    "pre",
    ["work"],
    [
      "workItemHash",
      "requestId",
      "contractRevision",
      "basisRef",
      "expectedHead",
      "completionCandidate",
      "unresolvedBlockerIds",
    ],
    ["audit.annotate", "run.abort", "work.allow_asserted"],
    ...preBoundary,
  ),
  "run.lifecycle.post": contract(
    "run.lifecycle.post",
    "post",
    ["run"],
    ["sessionId", "runId", "runOutcome"],
    ["audit.annotate"],
    ...postBoundary,
  ),
  "run.error.error": contract(
    "run.error.error",
    "error",
    ["run"],
    ["sessionId", "runId", "errorCode", "errorPhase"],
    ["audit.annotate", "run.abort", "run.retry_after"],
    "fail-closed",
    false,
  ),
} satisfies Record<RegisteredPolicyPointId, PolicyPointContractSnapshot>);

const id = z.string().min(1);
const requiredValue = z.unknown().refine((value) => value !== undefined, {
  message: "Required",
});

// Policy authority owns these equivalents so public schema mutation cannot change validation by reference.
const dispatchActor = z
  .object({
    // #498 A2 — mirrors THE canonical Actor.Kind vocabulary (kept as an
    // owned literal copy per the authority note above).
    kind: z.enum([
      "human",
      "ai_agent",
      "service",
      "resident",
      "internal_worker",
      "system",
      "unknown",
    ]),
    actorId: id,
    agentName: id.optional(),
    sessionId: id.optional(),
    runId: id.optional(),
    workerRunId: id.optional(),
    workspaceRoot: id.optional(),
    labels: z.array(z.string()).optional(),
    trustTier: z
      .enum(["owner", "co_owner", "manager", "collaborator", "observer", "assigned_worker"])
      .optional(),
    reason: id.optional(),
  })
  .strict();
const dispatchTarget = z
  .object({
    kind: z.enum([
      "worker",
      "resident",
      "external_actor",
      "schedule",
      "session",
      "surface",
      "system",
    ]),
    id: id.optional(),
    sessionId: id.optional(),
    parentSessionId: id.optional(),
    runId: id.optional(),
    endpointId: id.optional(),
    connectorInstallationId: id.optional(),
    name: id.optional(),
    labels: z.array(z.string()).optional(),
  })
  .strict();
const lifecycleRunOutcome = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("continue") }),
  z.object({ type: z.literal("compact") }),
  z.object({ type: z.literal("aborted") }),
  z.object({ type: z.literal("max-steps") }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      message: z.string(),
      name: z.string().optional(),
      stack: z.string().optional(),
    }),
  }),
]);
const toolSpec = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  safe: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  prompt: z.string().optional(),
});
const toolResult = z.object({
  id: z.string(),
  toolCallId: z.string(),
  // #500 C4: additive-optional denormalized tool name, mirrored from Tool.Result.
  toolName: z.string().optional(),
  output: z.string(),
  isError: z.boolean().optional(),
  settlement: z.enum(["settled", "unknown"]).optional(),
});


// Structural validator shape, written inline at every type position: a named
// interface here either leaks a private name into the emitted declaration
// file (TS4023) or becomes an export with no cross-module consumer.
function validator<Schema extends z.ZodTypeAny>(
  schema: Schema,
): {
  readonly parse: (input: unknown) => z.infer<Schema>;
  readonly safeParse: (input: unknown) => z.ZodSafeParseResult<z.infer<Schema>>;
} {
  return Object.freeze({
    parse: (input: unknown) => schema.parse(input),
    safeParse: (input: unknown) => schema.safeParse(input),
  });
}

const policyPointInputSchemas = Object.freeze({
  "dispatch.action.pre": validator(
    z
      .object({
        actor: dispatchActor,
        dispatchId: id,
        action: id,
        target: dispatchTarget,
        sessionId: id.optional(),
        runId: id.optional(),
      })
      .passthrough(),
  ),
  "run.lifecycle.pre": validator(z.object({ actorId: id, sessionId: id, runId: id }).passthrough()),
  "run.turn.pre": validator(
    z.object({ sessionId: id, runId: id, turnIndex: z.number().int().min(0) }).passthrough(),
  ),
  "prompt.context.pre": validator(
    z.object({ sessionId: id, runId: id, turnIndex: z.number().int().min(0) }).passthrough(),
  ),
  "tool.catalog.pre": validator(
    z.object({ sessionId: id, runId: id, availableTools: z.array(toolSpec) }).passthrough(),
  ),
  "connection.llm.pre": validator(
    z.object({ sessionId: id, runId: id, modelId: id }).passthrough(),
  ),
  "connection.llm.post": validator(
    z
      .object({
        sessionId: id,
        runId: id,
        modelId: id,
        responseTokens: z.number().int().min(0),
      })
      .passthrough(),
  ),
  "tool.native.pre": validator(
    z
      .object({
        sessionId: id,
        runId: id,
        toolId: id,
        toolInput: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  ),
  "tool.mcp.pre": validator(
    z
      .object({
        sessionId: id,
        runId: id,
        toolId: id,
        mcpServerId: id,
        toolInput: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  ),
  "delegation.worker.pre": validator(
    z
      .object({
        sessionId: id,
        runId: id,
        workerRunId: id,
        workerProfile: z.object({ name: id }).passthrough(),
      })
      .passthrough(),
  ),
  "tool.native.post": validator(
    z.object({ sessionId: id, runId: id, toolId: id, toolResult }).passthrough(),
  ),
  "tool.mcp.post": validator(
    z.object({ sessionId: id, runId: id, toolId: id, mcpServerId: id, toolResult }).passthrough(),
  ),
  "delegation.worker.post": validator(
    z
      .object({ sessionId: id, runId: id, workerRunId: id, workerResult: requiredValue })
      .passthrough(),
  ),
  "run.turn.post": validator(
    z
      .object({
        sessionId: id,
        runId: id,
        turnIndex: z.number().int().min(0),
        turnResult: requiredValue,
      })
      .passthrough(),
  ),
  "run.completion.pre": validator(
    z.object({ sessionId: id, runId: id, completionCandidate: requiredValue }).passthrough(),
  ),
  "work.complete.pre": validator(
    z
      .object({
        workItemHash: id,
        requestId: id,
        contractRevision: id,
        basisRef: id,
        expectedHead: z.number().int().nonnegative(),
        completionCandidate: requiredValue,
        unresolvedBlockerIds: z.array(id),
      })
      .passthrough(),
  ),
  "run.lifecycle.post": validator(
    z.object({ sessionId: id, runId: id, runOutcome: lifecycleRunOutcome }).passthrough(),
  ),
  "run.error.error": validator(
    z.object({ sessionId: id, runId: id, errorCode: id, errorPhase: id }).passthrough(),
  ),
} satisfies Record<
  RegisteredPolicyPointId,
  Readonly<{ parse: (input: unknown) => unknown; safeParse: (input: unknown) => unknown }>
>);

type PolicyPointInputMapType = {
  readonly [PointId in keyof typeof policyPointInputSchemas]: (typeof policyPointInputSchemas)[PointId] extends Readonly<{
    parse: (input: unknown) => infer Output;
  }>
    ? Output
    : never;
};

export namespace PolicyPointModule {
  export const PolicyPoint = Object.assign(policyPoint, {
    version: policyKernelVersion,
    Id: PolicyPointId,
    Contract: PolicyPointContract,
    RegistrySchema: z.record(PolicyPointId, PolicyPointContract),
    Registry: PolicyPointRegistry,
    InputSchemas: policyPointInputSchemas,
  });
  Object.defineProperties(PolicyPoint, {
    Registry: { configurable: false, writable: false },
    InputSchemas: { configurable: false, writable: false },
  });

  export type PolicyPoint = z.infer<typeof policyPoint>;

  export type PolicyPointInputMap = PolicyPointInputMapType;
}
