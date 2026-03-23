import type { Plan } from "@openomni/protocol";
import { Team } from "@openomni/protocol";
import { Bus } from "@openomni/session";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function safePublish<T>(...args: Parameters<typeof Bus.publish<T>>): void {
  try {
    Bus.publish(...args);
  } catch {
    // fire-and-forget
  }
}

export namespace ApprovalGate {
  export interface ApprovalContext {
    stepId: string;
    stepTitle: string;
    stepDescription?: string;
    plan: Plan;
  }

  export type ApprovalResult = "approved" | "rejected";

  export interface Gate {
    requestApproval(context: ApprovalContext): Promise<ApprovalResult>;
  }

  export interface DefaultGateConfig {
    timeoutMs?: number;
    onApprovalRequested?: (context: ApprovalContext) => void;
  }

  export function createDefaultGate(config?: DefaultGateConfig): Gate & {
    respond: (result: ApprovalResult) => void;
  } {
    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let pendingResolve: ((result: ApprovalResult) => void) | null = null;

    return {
      async requestApproval(context: ApprovalContext): Promise<ApprovalResult> {
        safePublish(Team.Events.ApprovalRequested, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          payload: {
            planId: context.plan.planId,
            stepId: context.stepId,
            stepTitle: context.stepTitle,
            stepDescription: context.stepDescription,
            timeoutMs,
          },
        });

        config?.onApprovalRequested?.(context);

        return new Promise<ApprovalResult>((resolve) => {
          pendingResolve = resolve;

          const timer = setTimeout(() => {
            if (pendingResolve === resolve) {
              pendingResolve = null;
              resolve("rejected");
            }
          }, timeoutMs);

          if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
          }
        });
      },

      respond(result: ApprovalResult): void {
        if (pendingResolve) {
          const resolver = pendingResolve;
          pendingResolve = null;
          resolver(result);
        }
      },
    };
  }

  export function respond(gate: Gate, result: ApprovalResult): void {
    if ("respond" in gate && typeof gate.respond === "function") {
      (gate as { respond: (result: ApprovalResult) => void }).respond(result);
    }
  }
}
