// server → openomni → agent → llm (direct agent imports forbidden)
import { IngressEngine } from "@openomni/openomni";
import type { Adapter, IngressResult } from "@openomni/protocol";
import { buildInboundEvent, type BridgeDeps } from "../ingress/bridge";
import { resolveAgentName } from "../router";

const queues = new Map<string, Promise<void>>();

function toResponseText(result: IngressResult): string {
  switch (result.mode) {
    case "direct":
      return result.result.output || "(no response)";
    case "plan":
      return `Plan generated: ${result.result.plan.goal}`;
    case "team":
      return "Team execution started...";
  }
}

async function processMessage(message: Adapter.InboundMessage, deps: BridgeDeps): Promise<string> {
  try {
    const agentName = resolveAgentName({ message, defaultAgent: "dev" });
    const event = buildInboundEvent(message, agentName, deps);
    return toResponseText(await IngressEngine.ingest(event));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[conversation] ingress error: ${msg}`);
    return `Error: ${msg}`;
  }
}

export function createMessageHandler(deps: BridgeDeps): Adapter.MessageHandler {
  return async (message) => {
    const key = message.surfaceKey;
    let text: string | null = null;
    let current!: Promise<void>;
    current = (queues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        text = await processMessage(message, deps);
      })
      .finally(() => {
        if (queues.get(key) === current) queues.delete(key);
      });

    queues.set(key, current);
    await current;
    return text ? { text } : null;
  };
}
