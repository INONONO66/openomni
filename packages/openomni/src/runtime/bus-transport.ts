import { Bus, BusEvent } from "@openomni/session";
import { Messenger } from "@openomni/protocol";
import type { z } from "zod";

export interface Transport {
  send(envelope: Messenger.MessageEnvelope): Promise<void>;
  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
}

const messengerEvent = BusEvent.define<Messenger.MessageEnvelope>(
  "messenger.envelope",
  Messenger.MessageEnvelopeSchema as z.ZodSchema<Messenger.MessageEnvelope>,
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
