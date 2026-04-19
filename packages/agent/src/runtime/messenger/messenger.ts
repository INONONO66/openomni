import type { Messenger } from "@openomni/protocol";

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
          throw new Error(`Authorization denied: ${envelope.fromAgentId} → ${envelope.toAgentId}`);
        }
        if (messageLog.length >= MAX_LOG_SIZE) {
          messageLog.splice(0, Math.floor(MAX_LOG_SIZE / 2));
        }
        messageLog.push(envelope);
        await transport.send(envelope);
      },

      subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void {
        return transport.subscribe(agentId, handler);
      },

      async request(
        envelope: Messenger.MessageEnvelope,
        reqOptions: RequestOptions,
      ): Promise<Messenger.MessageEnvelope> {
        const correlationId = envelope.id;

        return new Promise<Messenger.MessageEnvelope>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsub();
            reject(new Error(`Request timed out after ${reqOptions.timeout}ms`));
          }, reqOptions.timeout);

          const unsub = transport.subscribe(envelope.fromAgentId, (response) => {
            if (response.correlationId === correlationId) {
              clearTimeout(timer);
              unsub();
              resolve(response);
            }
          });

          if (reqOptions.signal) {
            reqOptions.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              unsub();
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
