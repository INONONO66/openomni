import { Bus, BusEvent } from "@openomni/session";
import type { Messenger } from "@openomni/protocol";

export interface Transport {
  send(envelope: Messenger.MessageEnvelope): Promise<void>;
  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
}

const messengerEvent = BusEvent.define<Messenger.MessageEnvelope>(
  "messenger.envelope",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { parse: (v: unknown) => v } as any,
);

export class BusTransport implements Transport {
  async send(envelope: Messenger.MessageEnvelope): Promise<void> {
    Bus.publish(messengerEvent, envelope);
  }

  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void {
    return Bus.subscribe(messengerEvent, (env) => {
      if (env.toAgentId === agentId) {
        handler(env);
      }
    });
  }
}
