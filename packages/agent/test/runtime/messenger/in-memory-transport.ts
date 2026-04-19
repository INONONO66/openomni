import type { Messenger } from "@openomni/protocol";
import type { Transport } from "../../../src/runtime/messenger/index";

export class InMemoryTransport implements Transport {
  private handlers: Map<string, ((env: Messenger.MessageEnvelope) => void)[]> = new Map();

  async send(envelope: Messenger.MessageEnvelope): Promise<void> {
    const handlers = this.handlers.get(envelope.toAgentId) ?? [];
    for (const h of handlers) h(envelope);
  }

  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void {
    const existing = this.handlers.get(agentId) ?? [];
    existing.push(handler);
    this.handlers.set(agentId, existing);
    return () => {
      const arr = this.handlers.get(agentId) ?? [];
      this.handlers.set(
        agentId,
        arr.filter((h) => h !== handler),
      );
    };
  }
}
