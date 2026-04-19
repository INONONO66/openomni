// server → openomni → agent → llm (direct agent imports forbidden)
import { IngressEngine } from "@openomni/openomni";
import type { Adapter, Ingress } from "@openomni/protocol";
import { resolveRuntimeModel } from "../agents/model-resolution";
import { buildInboundEvent, type BridgeDeps } from "../ingress/bridge";
import { resolveAgentName } from "../router";

function toResponseText(result: Ingress.IngressResult): string {
  switch (result.mode) {
    case "direct":
      return result.result.output || "(no response)";
    case "plan":
      return `Plan generated: ${result.result.planId}`;
  }
}

async function processMessage(message: Adapter.InboundMessage, deps: BridgeDeps): Promise<string> {
  try {
    const agentName = resolveAgentName({ message, defaultAgent: "dev" });
    const event = buildInboundEvent(message, agentName, deps);
    event.agent.model = await resolveRuntimeModel(event.agent.model, deps.defaultModel);
    return toResponseText(await IngressEngine.ingest(event));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[conversation] ingress error: ${msg}`);
    return `Error: ${msg}`;
  }
}

export function createMessageHandler(deps: BridgeDeps): Adapter.MessageHandler {
  const queues = new Map<string, Promise<void>>();
  return async (message) => {
    const key = message.surfaceKey;
    const prev = queues.get(key) ?? Promise.resolve();
    let text: string | null = null;
    const current: Promise<void> = prev
      .catch(() => undefined)
      .then(async () => {
        text = await processMessage(message, deps);
      });
    queues.set(key, current);
    try {
      await current;
    } finally {
      if (queues.get(key) === current) queues.delete(key);
    }
    return text ? { text } : null;
  };
}
