import type { Policy } from "@openomni/protocol";
import { PolicyDecision } from "@openomni/protocol";
import type { CanonicalPolicyRegistration, PolicyContext } from "@openomni/agent";
import {
  type MessagingLedgerService,
  requireCommittedMessagingTransition,
  requireMessagingLedgerService,
} from "../../ingress/session-resolver.js";
import type { InjectionQueue } from "../injection-queue.js";

const POLICY_ID = "builtin:injection-queue-drain";

type InjectionQueuePolicyContext = PolicyContext & {
  readonly runId?: string;
  readonly sessionId?: string;
};

export function createInjectionQueueDrainPolicy(
  queue: InjectionQueue.Instance,
  messaging?: MessagingLedgerService,
): CanonicalPolicyRegistration {
  return {
    name: POLICY_ID,
    kind: "point",
    pointIds: ["run.turn.post"],
    effectCapabilities: { "run.turn.post": ["prompt.inject_message"] },
    priority: 150,
    fn: async (ctx) => {
      const runId = contextString(ctx, "runId");
      if (runId === undefined || !queue.hasPending(runId)) {
        return PolicyDecision.allow({ policyId: POLICY_ID });
      }

      const pending = queue.drain(runId);
      const sessionId = contextString(ctx, "sessionId");
      const agentName = ctx.traceContext?.agentName;

      for (const response of pending) {
        if (response.injectToHistory === true && sessionId !== undefined) {
          await persistResponse(
            messaging ?? requireMessagingLedgerService(),
            sessionId,
            agentName ?? "injection-queue",
            response,
          );
        }
      }

      const effects: Policy.PolicyEffect[] = pending.map((response) => ({
        type: "prompt.inject_message",
        message: response.output,
        role: "assistant",
      }));

      return PolicyDecision.allow({
        policyId: POLICY_ID,
        reasonCodes: ["injection_queue_drained"],
        effects,
      });
    },
  };
}

function contextString(
  ctx: InjectionQueuePolicyContext,
  key: "runId" | "sessionId",
): string | undefined {
  const value = ctx[key];
  return typeof value === "string" ? value : undefined;
}

async function persistResponse(
  messaging: MessagingLedgerService,
  sessionId: string,
  agentName: string,
  response: InjectionQueue.PendingResponse,
): Promise<void> {
  requireCommittedMessagingTransition(
    await messaging.execute({
      kind: "MS-06",
      sessionId,
      messageId: response.messageId,
      partId: crypto.randomUUID(),
      role: "assistant",
      text: response.output,
      model: { provider: "injection-queue", id: "injection-queue" },
      agent: agentName,
      recordedAt: response.timestamp,
    }),
  );
}
