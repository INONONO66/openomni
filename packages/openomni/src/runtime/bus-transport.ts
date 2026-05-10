import { Operational, type Messenger } from "@openomni/protocol";
import { Bus } from "@openomni/session";

export interface Transport {
  send(envelope: Messenger.MessageEnvelope): Promise<void>;
  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
}

export class BusTransport implements Transport {
  private subscribers = new Map<string, Set<(env: Messenger.MessageEnvelope) => void>>();

  async send(envelope: Messenger.MessageEnvelope): Promise<void> {
    Bus.publish(Operational.Debug, {
      traceId: envelope.traceId ?? crypto.randomUUID(),
      time: Date.now(),
      component: "runtime.bus-transport",
      msg: "bus transport delivering envelope",
      context: { envelopeId: envelope.id, toAgentId: envelope.toAgentId },
    });

    const handlers = this.subscribers.get(envelope.toAgentId);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(envelope);
        } catch (error) {
          Bus.publish(Operational.Warn, {
            traceId: envelope.traceId ?? crypto.randomUUID(),
            time: Date.now(),
            component: "runtime.bus-transport",
            msg: "bus transport subscriber handler threw",
            context: {
              envelopeId: envelope.id,
              toAgentId: envelope.toAgentId,
              error: String(error),
            },
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

    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "runtime.bus-transport",
      msg: "bus transport subscriber registered",
      context: { agentId },
    });

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscribers.delete(agentId);
      }
    };
  }
}
