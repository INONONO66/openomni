import type { Messenger } from "@openomni/protocol";
import type { Transport } from "./transport";

const messageLog: Messenger.MessageEnvelope[] = [];

function matchesPattern(
  pattern: Messenger.AllowPattern,
  from: string,
  to: string,
): boolean {
  const fromMatch = pattern.from === "*" || pattern.from === from;
  const toMatch = pattern.to === "*" || pattern.to === to;
  return fromMatch && toMatch;
}

function isAuthorized(
  allowPatterns: Messenger.AllowPattern[] | undefined,
  from: string,
  to: string,
): boolean {
  if (!allowPatterns || allowPatterns.length === 0) return true;
  return allowPatterns.some((p) => matchesPattern(p, from, to));
}

export interface AgentMessengerOptions {
  allowPatterns?: Messenger.AllowPattern[];
}

export namespace AgentMessenger {
  export interface Instance {
    send(envelope: Messenger.MessageEnvelope): Promise<void>;
    subscribe(
      agentId: string,
      handler: (env: Messenger.MessageEnvelope) => void,
    ): () => void;
  }

  export function create(
    transport: Transport,
    options?: AgentMessengerOptions,
  ): Instance {
    return {
      async send(envelope: Messenger.MessageEnvelope): Promise<void> {
        if (
          !isAuthorized(
            options?.allowPatterns,
            envelope.fromAgentId,
            envelope.toAgentId,
          )
        ) {
          throw new Error(
            `Authorization denied: ${envelope.fromAgentId} → ${envelope.toAgentId}`,
          );
        }
        messageLog.push(envelope);
        await transport.send(envelope);
      },

      subscribe(
        agentId: string,
        handler: (env: Messenger.MessageEnvelope) => void,
      ): () => void {
        return transport.subscribe(agentId, handler);
      },
    };
  }

  export function getLog(): Messenger.MessageEnvelope[] {
    return [...messageLog];
  }

  export function _resetLog(): void {
    messageLog.length = 0;
  }
}
