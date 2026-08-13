import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

export namespace AuditLog {
  export function create(sessionId: string, scope: string) {
    return {
      append(
        type: string,
        payload: Record<string, unknown>,
        parentId?: string,
      ): { actionId: string } {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const actionId = `${sessionId}:${scope}:${type}:${suffix}`;
        Bus.publish(Operational.Info, {
          traceId: sessionId,
          sessionId,
          time: Date.now(),
          component: scope,
          msg: type,
          context: {
            audit: {
              actionId,
              ...(parentId !== undefined && { parentActionId: parentId }),
              payload,
            },
          },
        });
        return { actionId };
      },
    };
  }
}
