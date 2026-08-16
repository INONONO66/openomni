import type { Message, Policy } from "@openomni/protocol";
import { PolicyDecision } from "@openomni/protocol";
import { Storage, TranscriptStore } from "@openomni/session";
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

      const traceId = ctx.traceContext?.traceId;
      if (traceId === undefined || traceId.length === 0) {
        // A run turn without its trace is a wiring bug; draining under a mint
        // would launder the injections. Leave the queue intact — the next
        // correctly-traced turn drains it.
        throw new Error("injection queue drain requires the run trace context");
      }
      const pending = queue.drain(runId, traceId);
      const sessionId = contextString(ctx, "sessionId");
      const agentName = ctx.traceContext?.agentName;

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
  ctx: InjectionQueuePolicyContext,
  key: "runId" | "sessionId",
): string | undefined {
  const value = ctx[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * #562 F3: injected responses are recorded as SYNTHESIZED TRANSCRIPT FACTS
 * (message.created + part.appended + message.finished), not as
 * projection-only message/part rows. This seam writes into the same worker
 * session whose own turns record facts via the worker-runner onFact sink;
 * a projection-only write here would be invisible to every fact-stream
 * reader (TranscriptStore.replay folds only recorded facts), splitting the
 * session's history across two sources. TranscriptStore.record commits each
 * fact and its message/part projection in one storage transaction — one
 * source of truth (see the writer census in
 * packages/session/src/session/transcript.ts).
 *
 * The attemptId is derived from the injected messageId: injected responses
 * arrive whole (no retries, no streaming), so one message = one attempt, and
 * a duplicate drain of the same messageId rejects loudly in the fold
 * (created-on-existing) instead of duplicating history.
 */
function persistResponse(
  sessionId: string,
  agentName: string,
  response: InjectionQueue.PendingResponse,
): void {
  const message: Message.AssistantMessage = {
    id: response.messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: response.timestamp },
    parentID: "",
    modelID: "",
    providerID: "",
    agent: agentName,
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const attemptId = `${response.messageId}#inject`;
  // One injected response = one all-or-nothing unit: the outer transaction
  // makes the three per-fact transactions degrade to savepoints, so a
  // failure never strands a created-but-unfinished injected message.
  Storage.get().transaction(() => {
    TranscriptStore.record(sessionId, { type: "message.created", attemptId, message });
    TranscriptStore.record(sessionId, {
      type: "part.appended",
      attemptId,
      messageId: response.messageId,
      part: {
        id: `${response.messageId}-text`,
        sessionID: sessionId,
        messageID: response.messageId,
        type: "text",
        text: response.output,
        time: { start: response.timestamp },
      },
    });
    TranscriptStore.record(sessionId, {
      type: "message.finished",
      attemptId,
      messageId: response.messageId,
      at: response.timestamp,
      finish: "stop",
      usage: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });
}
