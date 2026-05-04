import { Log } from "@openomni/session";
import type { Messenger } from "@openomni/protocol";

export interface Transport {
  send(envelope: Messenger.MessageEnvelope): Promise<void>;
  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
}

export class BusTransport implements Transport {
  private subscribers = new Map<string, Set<(env: Messenger.MessageEnvelope) => void>>();

  async send(envelope: Messenger.MessageEnvelope): Promise<void> {
    Log.debug("bus transport delivering envelope", {
      envelopeId: envelope.id,
      traceId: envelope.traceId,
      toAgentId: envelope.toAgentId,
    });

    const handlers = this.subscribers.get(envelope.toAgentId);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(envelope);
        } catch (error) {
          Log.warn("bus transport subscriber handler threw", {
            envelopeId: envelope.id,
            toAgentId: envelope.toAgentId,
            error: String(error),
          });
        }
      }
    }
  }

  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, new Set());
    }

    const handlers = this.subscribers.get(agentId);
    if (!handlers) {
      throw new Error(`Failed to get handlers for agent ${agentId}`);
    }

    handlers.add(handler);

    Log.debug("bus transport subscriber registered", { agentId });

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscribers.delete(agentId);
      }
    };
  }
}
