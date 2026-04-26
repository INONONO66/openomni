import { MessengerEvent, type Messenger } from "@openomni/protocol";
import { Bus, Log } from "@openomni/session";

export interface Transport {
  send(envelope: Messenger.MessageEnvelope): Promise<void>;
  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
}

const MAX_LOG_SIZE = 1000;
const messageLog: Messenger.MessageEnvelope[] = [];

function matchesPattern(pattern: Messenger.AllowPattern, from: string, to: string): boolean {
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

export interface RequestOptions {
  timeout: number;
  signal?: AbortSignal;
}

export namespace AgentMessenger {
  export interface Instance {
    send(envelope: Messenger.MessageEnvelope): Promise<void>;
    subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
    request(
      envelope: Messenger.MessageEnvelope,
      options: RequestOptions,
    ): Promise<Messenger.MessageEnvelope>;
  }

  export function create(transport: Transport, options?: AgentMessengerOptions): Instance {
    return {
      async send(envelope: Messenger.MessageEnvelope): Promise<void> {
        if (!isAuthorized(options?.allowPatterns, envelope.fromAgentId, envelope.toAgentId)) {
          const traceId = envelope.traceId || crypto.randomUUID();
          Log.warn("messenger send authorization denied", {
            envelopeId: envelope.id,
            traceId,
            fromAgentId: envelope.fromAgentId,
            toAgentId: envelope.toAgentId,
          });
          Bus.publish(MessengerEvent.DeliveryFailed, {
            traceId,
            envelopeId: envelope.id,
            reason: `authorization denied: ${envelope.fromAgentId} → ${envelope.toAgentId}`,
            time: Date.now(),
          });
          throw new Error(`Authorization denied: ${envelope.fromAgentId} → ${envelope.toAgentId}`);
        }

        const traceId = envelope.traceId || crypto.randomUUID();
        const outbound = traceId !== envelope.traceId ? { ...envelope, traceId } : envelope;

        if (messageLog.length >= MAX_LOG_SIZE) {
          messageLog.splice(0, Math.floor(MAX_LOG_SIZE / 2));
        }
        messageLog.push(outbound);

        Log.debug("messenger envelope send", {
          envelopeId: outbound.id,
          traceId,
          fromAgentId: outbound.fromAgentId,
          toAgentId: outbound.toAgentId,
          correlationId: outbound.correlationId,
        });

        Bus.publish(MessengerEvent.EnvelopeCreated, {
          traceId,
          envelopeId: outbound.id,
          fromAgentId: outbound.fromAgentId,
          toAgentId: outbound.toAgentId,
          correlationId: outbound.correlationId,
          time: Date.now(),
        });

        try {
          await transport.send(outbound);
          Log.debug("messenger envelope delivered", {
            envelopeId: outbound.id,
            traceId,
            fromAgentId: outbound.fromAgentId,
            toAgentId: outbound.toAgentId,
          });
          Bus.publish(MessengerEvent.Delivered, {
            traceId,
            envelopeId: outbound.id,
            fromAgentId: outbound.fromAgentId,
            toAgentId: outbound.toAgentId,
            time: Date.now(),
          });
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          Log.warn("messenger delivery failed", {
            envelopeId: outbound.id,
            traceId,
            reason,
          });
          Bus.publish(MessengerEvent.DeliveryFailed, {
            traceId,
            envelopeId: outbound.id,
            reason,
            time: Date.now(),
          });
          throw err;
        }
      },

      subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void {
        Log.debug("messenger subscribe registered", { agentId });
        return transport.subscribe(agentId, (env) => {
          Log.debug("messenger envelope received", {
            envelopeId: env.id,
            traceId: env.traceId,
            fromAgentId: env.fromAgentId,
            toAgentId: env.toAgentId,
          });
          handler(env);
        });
      },

      async request(
        envelope: Messenger.MessageEnvelope,
        reqOptions: RequestOptions,
      ): Promise<Messenger.MessageEnvelope> {
        const correlationId = envelope.id;

        return new Promise<Messenger.MessageEnvelope>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsub();
            Log.warn("messenger request timed out", {
              envelopeId: envelope.id,
              traceId: envelope.traceId,
              fromAgentId: envelope.fromAgentId,
              toAgentId: envelope.toAgentId,
              timeoutMs: reqOptions.timeout,
            });
            reject(new Error(`Request timed out after ${reqOptions.timeout}ms`));
          }, reqOptions.timeout);

          const unsub = transport.subscribe(envelope.fromAgentId, (response) => {
            if (response.correlationId === correlationId) {
              clearTimeout(timer);
              unsub();
              Log.debug("messenger request response received", {
                envelopeId: response.id,
                traceId: response.traceId,
                correlationId,
                fromAgentId: response.fromAgentId,
              });
              resolve(response);
            }
          });

          if (reqOptions.signal) {
            reqOptions.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              unsub();
              Log.warn("messenger request aborted", {
                envelopeId: envelope.id,
                traceId: envelope.traceId,
              });
              reject(new Error("Request aborted"));
            });
          }

          this.send(envelope).catch((err: unknown) => {
            clearTimeout(timer);
            unsub();
            reject(err);
          });
        });
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
