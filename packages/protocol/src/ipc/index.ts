import { z } from "zod";
import { Execution } from "../execution/index.js";
import { Machine } from "../machine/index.js";
import { Tool } from "../tool/index.js";
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
  /**
   * Machine daemon → machine host (docs/machines-and-delegation.md §2):
   * the daemon offers its capability set, the host answers with the
   * enrollment∩offer effective set or a typed refusal. The localhost slice
   * carries no auth token — the Unix socket is the trust boundary; remote
   * transports add authentication as an additive field when they land.
   */
  "machine.attach": {
    params: Machine.Offer,
    result: Machine.AttachResult,
  },
  "coordinator.spawn_run": {
    /**
     * #500 B1: the params ARE the canonical spawn config — Execution.Request
     * (parsed worker-side at apps/server worker-runner) plus the supervisor's
     * per-worker auth token. The previous inline clone had drifted from the
     * wire: it omitted required `mode`/`traceId` (every sender spreads the
     * full Execution.Request), and carried `softTimeoutMs`/`hardTimeoutMs`
     * that no sender wrote and no receiver read — the delivery ceiling is
     * derived from `budget.maxWallTimeMs` (supervisor-process). Wire values
     * unchanged; entry now matches reality. `credentials` stays IronClaw
     * capability injection — workers never read env vars for API keys.
     */
    params: Execution.Request.extend({ authToken: z.string() }),
    /**
     * #500 B3 drift fix: the worker has always responded with an
     * Execution.Result frame (status/output/error), never `{ accepted }` —
     * the consumer (apps/server execution coordinator) parses exactly that.
     */
    result: Execution.Result,
  },
  "coordinator.cancel_run": {
    params: z.object({ authToken: z.string(), runId: z.string(), sessionId: z.string() }),
    result: z.object({
      cancelled: z.boolean(),
      error: z.string().optional(),
      // #500 B3: the worker's confirmation frame echoes the run it aborted.
      runId: z.string().optional(),
      sessionId: z.string().optional(),
    }),
  },
  "worker.deliver_message": {
    params: z.object({
      authToken: z.string(),
      /**
       * The trace of the flow delivering the message (dispatch command or
       * inbound frame). Required for the same reason as worker.inbound_wait:
       * the injection this delivery queues must file under the sender's
       * trace, not a mint of the receiving worker's.
       */
      traceId: z.string().min(1),
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
  "worker.inbound_wait": {
    params: z.object({
      authToken: z.string(),
      workerId: z.string(),
      /**
       * The trace of the worker run that is asking. Required: the Resident
       * dispatches under it, and a call that cannot name its trace would put
       * both sides of one conversation on separate traces.
       */
      traceId: z.string().min(1),
      sessionId: z.string(),
      runId: z.string().optional(),
      callId: z.string().optional(),
      payload: z.string(),
      workspaceRoot: z.string().optional(),
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
  "worker.bootstrap_ready": {
    params: z.object({ workerId: z.string(), authToken: z.string() }),
    result: z.null(),
  },
  "worker.tool_call": {
    params: z.object({
      authToken: z.string(),
      runId: z.string(),
      sessionId: z.string(),
      callId: z.string(),
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
      workspaceRoot: z.string().optional(),
    }),
    /**
     * #500 C4: the result frame IS a Tool.Result — the inline clone had
     * already drifted once and would again. Referencing the canonical schema
     * also carries the additive-optional `toolName` across the UDS boundary
     * (safe wire evolution: optional field, both ends parse Tool.Result).
     */
    result: Tool.Result,
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
  "worker.inbound_wait_cancel": {
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
      // #500 B3 drift fix: the receiving worker has always REQUIRED the token
      // (unauthorized frames are refused) and the supervisor always sends it —
      // the `.optional()` here documented a tolerance that never existed.
      authToken: z.string(),
      callId: z.string(),
      workspaceRoot: z.string().optional(),
    }),
    result: z.object({ acknowledged: z.boolean(), error: z.string().optional() }),
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
