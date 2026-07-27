import { z } from "zod";
import { Model } from "../model/index.js";
import { Execution } from "../execution/index.js";
import { Ledger } from "../ledger/index.js";
import { Tool } from "../tool/index.js";

const baseMessage = z.object({
  v: z.literal(2),
  id: z.string().optional(),
});

const requestSchema = baseMessage.extend({
  type: z.literal("request"),
  id: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const responseSchema = baseMessage.extend({
  type: z.literal("response"),
  id: z.string(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

const notificationSchema = baseMessage.extend({
  type: z.literal("notification"),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Same-version internal method parameter contracts.
 *
 * The generic request envelope above intentionally stays permissive; these
 * method schemas document and test the canonical params expected by current
 * workers/coordinators.
 */
const authenticatedWorkerParams = {
  authToken: z.string().min(1),
  workerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
};

const workerRuntimeDefinitionV1 = z
  .object({
    runtimeId: z.string().min(1),
    workerId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    principalId: z.string().min(1),
    attempt: Ledger.AttemptRefV1,
    config: z
      .object({
        configEpoch: z.string().min(1),
        model: Model.Ref,
        environment: Execution.LLMEnvironmentV1,
        workspace: Execution.WorkspaceRefV1,
        agents: z.array(z.object({ name: z.string().min(1) }).passthrough()),
        toolCatalog: z.array(Tool.Spec),
        budget: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
const credentialProvisioningChannelIdentityV1 = z
  .object({
    runtimeId: z.string().min(1),
    workerId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    principalId: z.string().min(1),
    attempt: Ledger.AttemptRefV1,
    processId: z.number().int().positive(),
    runId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

const credentialProvisioningFrameV1 = z
  .object({
    request: Execution.CredentialProvisioningRequestV1,
    channelIdentity: credentialProvisioningChannelIdentityV1,
  })
  .strict();

const methods = {
  "coordinator.bootstrap": {
    params: z
      .object({
        authToken: z.string().min(1),
        runtimeId: z.string().min(1),
        workerId: z.string().min(1),
        generation: z.number().int().nonnegative(),
        configEpoch: z.string().min(1),
      })
      .strict(),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }).strict(),
  },
  "coordinator.spawn_run": {
    params: z
      .object({
        authToken: z.string().min(1),
        runId: z.string().min(1),
        sessionId: z.string().min(1),
        prompt: z.string(),
        runtime: workerRuntimeDefinitionV1,
      })
      .strict(),
    result: z.discriminatedUnion("status", [
      z
        .object({
          runId: z.string().min(1),
          sessionId: z.string().min(1),
          status: z.literal("succeeded"),
          output: z.string(),
          finishReason: z.string(),
        })
        .strict(),
      z
        .object({
          runId: z.string().min(1),
          sessionId: z.string().min(1),
          status: z.enum(["failed", "cancelled"]),
          error: z.string(),
        })
        .strict(),
    ]),
  },
  "coordinator.cancel_run": {
    params: z
      .object({ authToken: z.string().min(1), runId: z.string(), sessionId: z.string() })
      .strict(),
    result: z.object({ cancelled: z.boolean(), error: z.string().optional() }).strict(),
  },
  "worker.deliver_message": {
    params: z
      .object({
        authToken: z.string().min(1),
        sessionId: z.string().min(1),
        runId: z.string().optional(),
        message: z.string(),
      })
      .strict(),
    result: z.object({ accepted: z.boolean(), error: z.string().optional() }).strict(),
  },
  "worker.shutdown_idle": {
    params: z
      .object({
        authToken: z.string().min(1),
        workerId: z.string().min(1),
        reason: z.string().optional(),
      })
      .strict(),
    result: z.object({ acknowledged: z.boolean(), error: z.string().optional() }).strict(),
  },
  "worker.bootstrap_ready": {
    params: z
      .object({
        authToken: z.string().min(1),
        runtimeId: z.string().min(1),
        workerId: z.string().min(1),
        generation: z.number().int().nonnegative(),
      })
      .strict(),
    result: z.null(),
  },
  "worker.kernel_transition": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        command: z
          .object({
            version: z.literal("kernel-transition-command-v1"),
            transitionId: Execution.ClosedOperationIdV1,
            command: Execution.ClosedCommandNameV1,
            requestId: z.string().min(1),
            requestHash: z.string().regex(/^[0-9a-f]{64}$/),
            expectedHead: z.unknown(),
            payload: z.unknown(),
          })
          .strict(),
      })
      .strict(),
    result: Execution.KernelTransitionResultV1,
  },
  "worker.kernel_query": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        request: z
          .object({
            version: z.literal("kernel-query-v1"),
            kind: z.enum([
              "authenticated_transcript",
              "authenticated_attempt",
              "authenticated_wait",
            ]),
          })
          .passthrough()
          .superRefine((request, context) => {
            if ("identity" in request) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "worker kernel query identity is server-bound",
                path: ["identity"],
              });
            }
          }),
      })
      .strict(),
    result: Execution.KernelQueryResultV1,
  },
  "worker.observation": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        observation: z
          .object({
            name: z.string().min(1),
            data: z.unknown(),
          })
          .strict(),
      })
      .strict(),
    result: z.null(),
  },
  "worker.tool_call": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        callId: z.string().min(1),
        tool: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
        workspaceRoot: z.string().min(1).optional(),
      })
      .strict(),
    result: Tool.Result.strict().nullable(),
  },
  "worker.tool_call_cancel": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        callId: z.string().min(1),
      })
      .strict(),
    result: z
      .object({
        cancelled: z.boolean(),
        error: z.string().optional(),
        settlement: z.literal("unknown").optional(),
      })
      .strict(),
  },
  "worker.inbound_wait": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        callId: z.string().min(1).optional(),
        payload: z.string().min(1),
        workspaceRoot: z.string().min(1).optional(),
      })
      .strict(),
    result: z
      .object({
        requestId: z.string().min(1),
        accepted: z.boolean(),
        output: z.string().optional(),
        error: z.string().optional(),
      })
      .strict(),
  },
  "worker.inbound_wait_cancel": {
    params: z
      .object({
        ...authenticatedWorkerParams,
        callId: z.string().min(1),
      })
      .strict(),
    result: z
      .object({
        cancelled: z.boolean(),
        error: z.string().optional(),
        settlement: z.literal("unknown").optional(),
      })
      .strict(),
  },
  "worker.credential_provision": {
    params: z
      .object({
        workerId: z.string().min(1),
        generation: z.number().int().nonnegative(),
        runId: z.string().min(1),
        sessionId: z.string().min(1),
        request: Execution.CredentialProvisioningRequestV1,
      })
      .strict()
      .superRefine((params, context) => {
        if (params.generation !== params.request.generation) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "credential request generation does not match worker generation",
            path: ["request", "generation"],
          });
        }
        if (params.workerId !== params.request.workerId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "credential request worker does not match authenticated worker",
            path: ["request", "workerId"],
          });
        }
      }),
    result: Execution.CredentialProvisioningReceiptV1,
  },
  "worker.credential_provision_ack": {
    params: z
      .object({
        workerId: z.string().min(1),
        generation: z.number().int().nonnegative(),
        processId: z.number().int().positive(),
        runId: z.string().min(1),
        sessionId: z.string().min(1),
        receipt: Execution.CredentialProvisioningReceiptV1,
      })
      .strict()
      .superRefine((params, context) => {
        if (params.workerId !== params.receipt.workerId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "credential acknowledgement worker does not match receipt",
            path: ["receipt", "workerId"],
          });
        }
        if (params.generation !== params.receipt.generation) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "credential acknowledgement generation does not match receipt",
            path: ["receipt", "generation"],
          });
        }
      }),
    result: z.object({ accepted: z.literal(true) }).strict(),
  },
};

export namespace Ipc {
  export const Request = requestSchema;
  export const Response = responseSchema;
  export const Notification = notificationSchema;
  export const Methods = methods;
  export const WorkerRuntimeDefinitionV1 = workerRuntimeDefinitionV1;
  export type Request = z.infer<typeof requestSchema>;
  export type Response = z.infer<typeof responseSchema>;
  export type Notification = z.infer<typeof notificationSchema>;
  export type WorkerRuntimeDefinitionV1 = z.infer<typeof workerRuntimeDefinitionV1>;
  export type CoordinatorSpawnRunResultV1 = z.infer<
    (typeof methods)["coordinator.spawn_run"]["result"]
  >;
  export type WorkerKernelTransitionRequestV1 = z.infer<
    (typeof methods)["worker.kernel_transition"]["params"]
  >;
  export type WorkerKernelTransitionResultV1 = z.infer<
    (typeof methods)["worker.kernel_transition"]["result"]
  >;
  export type WorkerKernelQueryRequestV1 = z.infer<
    (typeof methods)["worker.kernel_query"]["params"]
  >;
  export type WorkerKernelQueryResultV1 = z.infer<
    (typeof methods)["worker.kernel_query"]["result"]
  >;
  export type WorkerObservationV1 = z.infer<(typeof methods)["worker.observation"]["params"]>;
  export type CredentialProvisioningFrameV1 = z.infer<typeof credentialProvisioningFrameV1>;
  export type CredentialProvisioningReceiptV1 = z.infer<
    (typeof methods)["worker.credential_provision"]["result"]
  >;
  export type CredentialProvisioningAcknowledgementV1 = z.infer<
    (typeof methods)["worker.credential_provision_ack"]["params"]
  >;
  export type CredentialProvisioningPortResultV1 = {
    readonly privateFrame: Uint8Array;
    readonly receipt: CredentialProvisioningReceiptV1;
    readonly acknowledge: (
      acknowledgement: CredentialProvisioningAcknowledgementV1,
    ) => Promise<void>;
  };

  const version = 2;

  export function createRequest(method: string, params?: Record<string, unknown>): Request {
    return { v: version, type: "request", id: crypto.randomUUID(), method, params };
  }

  export function createResponse(id: string, result: unknown): Response {
    return { v: version, type: "response", id, result };
  }

  export function createErrorResponse(id: string, code: number, message: string): Response {
    return { v: version, type: "response", id, error: { code, message } };
  }

  export function createNotification(
    method: string,
    params?: Record<string, unknown>,
  ): Notification {
    return { v: version, type: "notification", method, params };
  }
}
