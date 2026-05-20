import type { Message, Policy } from "@openomni/protocol";
import { PolicyDecision } from "@openomni/protocol";
import { Session } from "@openomni/session";
import type { PolicyContext, PolicyRegistration } from "@openomni/agent";
import type { InjectionQueue } from "../injection-queue.js";

const POLICY_ID = "builtin:injection-queue-drain";

export function createInjectionQueueDrainPolicy(
  queue: InjectionQueue.Instance,
): PolicyRegistration {
  return {
    name: POLICY_ID,
    timing: "turn.finish",
    priority: 150,
    fn: (ctx) => {
      const runId = contextString(ctx, "runId") ?? ctx.traceContext?.runId;
      if (runId === undefined || !queue.hasPending(runId)) {
        return PolicyDecision.allow({ policyId: POLICY_ID });
      }

      const pending = queue.drain(runId);
      const sessionId = contextString(ctx, "sessionId") ?? ctx.traceContext?.sessionId;
      const agentName = contextString(ctx, "agentName") ?? ctx.traceContext?.agentName;

      for (const response of pending) {
        if (response.injectToHistory === true && sessionId !== undefined) {
          try {
            persistResponse(sessionId, agentName ?? "injection-queue", response);
          } catch {
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
  ctx: PolicyContext,
  key: "agentName" | "runId" | "sessionId",
): string | undefined {
  const value = (ctx as unknown as Record<string, unknown>)[key];
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
