import { agentMetadata, getAllAgentNames } from "./agents/registry";
import type { Adapter } from "@openomni/protocol";

export interface RoutingContext {
  message: Adapter.InboundMessage;
  defaultAgent?: string;
}

export function resolveAgentName(ctx: RoutingContext): string {
  const slashMatch = parseSlashCommand(ctx.message.text);
  if (slashMatch) {
    const agentName = findAgentBySlashCommand(slashMatch.command);
    if (agentName) return agentName;
  }

  const channelAgent = findAgentByChannel(ctx.message.surfaceKey);
  if (channelAgent) return channelAgent;

  return ctx.defaultAgent ?? "dev";
}

function parseSlashCommand(text: string): { command: string; rest: string } | null {
  if (!text.startsWith("/")) return null;

  const parts = text.slice(1).split(/\s+/);
  const command = parts[0];
  if (!command) return null;

  return { command, rest: parts.slice(1).join(" ") };
}

function findAgentBySlashCommand(command: string): string | undefined {
  const knownAgents = new Set(getAllAgentNames());

  for (const [name, meta] of agentMetadata) {
    if (knownAgents.has(name) && meta.triggers?.slashCommand === command) {
      return name;
    }
  }

  return undefined;
}

function findAgentByChannel(surfaceKey: string): string | undefined {
  const key = surfaceKey.toLowerCase();

  for (const [name, meta] of agentMetadata) {
    if (
      meta.triggers?.channels?.some((ch) => {
        const pattern = ch.toLowerCase();
        return key === pattern || key.startsWith(`${pattern}:`);
      })
    ) {
      return name;
    }
  }

  return undefined;
}
