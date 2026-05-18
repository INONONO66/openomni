import { z } from "zod";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { WorkerBootstrap } from "../worker-bootstrap/index.js";

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
const methods = {
  "coordinator.spawn_run": {
    params: z.object({
      authToken: z.string(),
      runId: z.string(),
      sessionId: z.string(),
      prompt: z.string(),
      model: Model.Ref,
      systemPrompt: z.string().optional(),
      // IronClaw capability injection — workers never read env vars for API keys
      credentials: z.record(z.string()).optional(),
      permissions: Policy.Permission.optional(),
      softTimeoutMs: z.number().optional(),
      hardTimeoutMs: z.number().optional(),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  "coordinator.cancel_run": {
    params: z.object({ authToken: z.string(), runId: z.string(), sessionId: z.string() }),
    result: z.object({ cancelled: z.boolean(), error: z.string().optional() }),
  },
  "worker.deliver_message": {
    params: z.object({
      authToken: z.string(),
      sessionId: z.string(),
      runId: z.string().optional(),
      message: z.string(),
    }),
    result: z.object({ accepted: z.boolean(), error: z.string().optional() }),
  },
  "worker.shutdown_idle": {
    params: z.object({
      authToken: z.string(),
      workerId: z.string(),
      reason: z.string().optional(),
    }),
    result: z.object({ acknowledged: z.boolean(), error: z.string().optional() }),
  },
  "worker.ask_main": {
    params: z.object({
      authToken: z.string(),
      workerId: z.string(),
      sessionId: z.string(),
      runId: z.string().optional(),
      question: z.string(),
    }),
    result: z.object({
      requestId: z.string(),
      accepted: z.boolean(),
      output: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  "coordinator.bootstrap": {
    params: z.object({ authToken: z.string(), bootstrap: WorkerBootstrap.Bootstrap }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  // Central tool permission enforcement — workers ask coordinator before executing any tool
  "coordinator.check_permission": {
    params: z.object({
      runId: z.string(),
      sessionId: z.string(),
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
    }),
    result: z.object({ allowed: z.boolean(), reason: z.string().optional() }),
  },
  "worker.ready": {
    params: z.object({ workerId: z.string(), pid: z.number() }),
    result: z.object({
      acknowledged: z.boolean(),
      bootstrap: WorkerBootstrap.Bootstrap.optional(),
    }),
  },
  "worker.bootstrap_ready": {
    params: z.object({ workerId: z.string(), authToken: z.string() }),
    result: z.null(),
  },
  "worker.heartbeat": {
    params: z.object({
      authToken: z.string(),
      workerId: z.string(),
      activeRunIds: z.array(z.string()),
      memoryRssMb: z.number(),
      snapshot: WorkerBootstrap.WorkerSnapshot.optional(),
    }),
    result: z.null(),
  },
  "worker.run_started": {
    params: z.object({ runId: z.string(), sessionId: z.string() }),
    result: z.null(),
  },
  "worker.run_completed": {
    params: z.object({
      runId: z.string(),
      sessionId: z.string(),
      status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
      output: z.string().optional(),
      error: z.string().optional(),
    }),
    result: z.null(),
  },
  "worker.tool_call": {
    params: z.object({
      runId: z.string(),
      sessionId: z.string(),
      callId: z.string(),
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
      workspaceRoot: z.string().optional(),
    }),
    result: z.object({
      id: z.string(),
      toolCallId: z.string(),
      output: z.string(),
      isError: z.boolean().optional(),
      settlement: z.enum(["settled", "unknown"]).optional(),
    }),
  },
  "worker.tool_call_cancel": {
    params: z.object({
      runId: z.string(),
      sessionId: z.string(),
      callId: z.string(),
    }),
    result: z.object({
      cancelled: z.boolean(),
      settlement: z.enum(["settled", "unknown"]).optional(),
      error: z.string().optional(),
    }),
  },
  "worker.ask_main_cancel": {
    params: z.object({
      runId: z.string().optional(),
      sessionId: z.string(),
      callId: z.string(),
    }),
    result: z.object({
      cancelled: z.boolean(),
      settlement: z.enum(["settled", "unknown"]).optional(),
      error: z.string().optional(),
    }),
  },
  "worker.tool_call_settled": {
    params: z.object({
      authToken: z.string().optional(),
      callId: z.string(),
      workspaceRoot: z.string().optional(),
    }),
    result: z.object({ acknowledged: z.boolean(), error: z.string().optional() }),
  },
  "worker.state_update": {
    params: z.object({
      runId: z.string(),
      sessionId: z.string(),
      event: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
    result: z.null(),
  },
  "worker.request_restart": {
    params: z.object({
      workerId: z.string(),
      reason: z.string(),
    }),
    result: z.object({ acknowledged: z.boolean() }),
  },
};

export namespace Ipc {
  export const Request = requestSchema;
  export const Response = responseSchema;
  export const Notification = notificationSchema;
  export const Methods = methods;

  export type Request = z.infer<typeof requestSchema>;
  export type Response = z.infer<typeof responseSchema>;
  export type Notification = z.infer<typeof notificationSchema>;

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
