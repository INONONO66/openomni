import type { Message, Policy } from "@openomni/protocol";
import { PolicyDecision } from "@openomni/protocol";
import { Session } from "@openomni/session";
import type { CanonicalPolicyRegistration, PolicyContext } from "@openomni/agent";
import type { InjectionQueue } from "../injection-queue.js";

const POLICY_ID = "builtin:injection-queue-drain";

type InjectionQueuePolicyContext = PolicyContext & {
  readonly runId?: string;
  readonly sessionId?: string;
};

export function createInjectionQueueDrainPolicy(
  queue: InjectionQueue.Instance,
): CanonicalPolicyRegistration {
  return {
    name: POLICY_ID,
    kind: "point",
    pointIds: ["run.turn.post"],
    effectCapabilities: { "run.turn.post": ["prompt.inject_message"] },
    priority: 150,
    fn: (ctx) => {
      const runId = contextString(ctx, "runId");
      if (runId === undefined || !queue.hasPending(runId)) {
        return PolicyDecision.allow({ policyId: POLICY_ID });
      }

      const pending = queue.drain(runId);
      const sessionId = contextString(ctx, "sessionId");
      const agentName = ctx.traceContext?.agentName;

      for (const response of pending) {
        if (response.injectToHistory === true && sessionId !== undefined) {
          try {
            persistResponse(sessionId, agentName ?? "injection-queue", response);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            // storage failure must not abort the drain — effects still need to be emitted
          }
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

function persistResponse(
  sessionId: string,
  agentName: string,
  response: InjectionQueue.PendingResponse,
): void {
  const message: Message.AssistantMessage = {
    id: response.messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: response.timestamp, completed: response.timestamp },
    parentID: "",
    modelID: "",
    providerID: "",
    agent: agentName,
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  Session.addMessage(sessionId, message);
  Session.addPart(response.messageId, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: response.messageId,
    type: "text",
    text: response.output,
  });
}
