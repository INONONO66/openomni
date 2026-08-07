import { z } from "zod";
import type { PolicyPointContractModule } from "./point-contract.js";

const id = z.string().min(1);
const requiredValue = z.unknown().refine((value) => value !== undefined, {
  message: "Required",
});

// Policy authority owns these equivalents so public schema mutation cannot change validation by reference.
const dispatchActor = z
  .object({
    kind: z.enum(["worker", "resident", "system", "user", "unknown"]),
    actorId: id,
    agentName: id.optional(),
    sessionId: id.optional(),
    runId: id.optional(),
    workerRunId: id.optional(),
    workspaceRoot: id.optional(),
    permissions: z.array(z.string()).optional(),
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
  output: z.string(),
  isError: z.boolean().optional(),
  settlement: z.enum(["settled", "unknown"]).optional(),
});

export interface PolicyPointInputValidator<Output> {
  readonly parse: (input: unknown) => Output;
  readonly safeParse: (input: unknown) => z.SafeParseReturnType<unknown, Output>;
}

function validator<Schema extends z.ZodTypeAny>(
  schema: Schema,
): PolicyPointInputValidator<z.infer<Schema>> {
  return Object.freeze({
    parse: (input: unknown) => schema.parse(input),
    safeParse: (input: unknown) => schema.safeParse(input),
  });
}

export const policyPointInputSchemas = Object.freeze({
  "session.inbound.pre": validator(
    z.object({ actorId: id, sessionId: id, inboundEvent: requiredValue }).passthrough(),
  ),
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
  "session.writeback.pre": validator(
    z.object({ sessionId: id, runId: id, writebackPayload: requiredValue }).passthrough(),
  ),
  "run.lifecycle.post": validator(
    z.object({ sessionId: id, runId: id, runOutcome: lifecycleRunOutcome }).passthrough(),
  ),
  "run.error.error": validator(
    z.object({ sessionId: id, runId: id, errorCode: id, errorPhase: id }).passthrough(),
  ),
} satisfies Record<
  PolicyPointContractModule.RegisteredPolicyPointId,
  PolicyPointInputValidator<unknown>
>);

export type PolicyPointInputMap = {
  readonly [PointId in keyof typeof policyPointInputSchemas]: (typeof policyPointInputSchemas)[PointId] extends PolicyPointInputValidator<
    infer Output
  >
    ? Output
    : never;
};
