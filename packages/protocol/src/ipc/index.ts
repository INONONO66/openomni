import { z } from "zod";
import { Machine } from "../machine/index.js";

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
 * machine hosts/daemons.
 */
const methods = {
  /**
   * Machine daemon → machine host (docs/machines-and-delegation.md §2):
   * the daemon offers its capability set, the host answers with the
   * enrollment∩offer effective set or a typed refusal. The localhost slice
   * carries no auth token — the Unix socket is the trust boundary; remote
   * transports add authentication as an additive field when they land.
   */
  [Machine.WireMethod.Attach]: {
    params: Machine.Offer,
    result: Machine.AttachResult,
  },
  [Machine.WireMethod.RunCell]: {
    params: Machine.CellRequest,
    result: Machine.CellResult,
  },
  /**
   * Machine daemon → machine host, made from inside a running cell
   * (docs/machines-and-delegation.md §5.5): the reverse direction of RunCell,
   * on the same attachment, so one cell can batch what would otherwise be N
   * tool round trips.
   */
  [Machine.WireMethod.CallTool]: {
    params: Machine.ToolCall,
    result: Machine.ToolCallResult,
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
