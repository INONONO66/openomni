import { MessengerEvent, Operational, type Messenger, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentRuntimeContext } from "../../core/runtime-context";
import { getDefaultContext } from "../../core/runtime-context";
import { PolicyEngine } from "../../core/policy/engine";
import { createMessengerAllowPatternPolicy } from "../../core/policy/builtin/messenger-allow-pattern";

export interface Transport {
  send(envelope: Messenger.MessageEnvelope): Promise<void>;
  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void;
}

export interface AgentMessengerOptions {
  allowPatterns?: Messenger.AllowPattern[];
  context?: AgentRuntimeContext;
}

export interface RequestOptions {
  timeout: number;
  signal?: AbortSignal;
}

function assertSendAllowed(verdict: Policy.Verdict, envelope: Messenger.MessageEnvelope): void {
  switch (verdict.action) {
    case "continue":
      return;
    case "skip":
    case "abort":
    case "retry":
    case "transform":
    case "inject":
    case "deny": {
      const traceId = envelope.traceId || crypto.randomUUID();
      Bus.publish(Operational.Warn, {
        traceId,
        time: Date.now(),
        component: "messenger:send",
        msg: "messenger send authorization denied",
        context: {
          envelopeId: envelope.id,
          fromAgentId: envelope.fromAgentId,
          toAgentId: envelope.toAgentId,
          reason: verdict.reason,
          policyId: verdict.policyId,
        },
      });
      Bus.publish(MessengerEvent.DeliveryFailed, {
        traceId,
        envelopeId: envelope.id,
        reason: `authorization denied: ${envelope.fromAgentId} → ${envelope.toAgentId}`,
        time: Date.now(),
      });
      throw new Error(`Authorization denied: ${envelope.fromAgentId} → ${envelope.toAgentId}`);
    }
  }
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
    const context = options?.context ?? getDefaultContext();
    const engine = PolicyEngine.create();

    if (options?.allowPatterns) {
      engine.register(createMessengerAllowPatternPolicy({ allowPatterns: options.allowPatterns }));
    }

    return {
      async send(envelope: Messenger.MessageEnvelope): Promise<void> {
        const verdict = await engine.dispatchLegacy("invoke.prepare", {
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turnCount: 0,
          isCompletion: false,
          continuationCount: 0,
          elapsedMs: 0,
          envelope,
        });

        assertSendAllowed(verdict, envelope);

        const traceId = envelope.traceId || crypto.randomUUID();
        const outbound = traceId !== envelope.traceId ? { ...envelope, traceId } : envelope;

        context.messageLog.append(outbound);

        Bus.publish(Operational.Debug, {
          traceId,
          time: Date.now(),
          component: "messenger:send",
          msg: "messenger envelope send",
          context: {
            envelopeId: outbound.id,
            fromAgentId: outbound.fromAgentId,
            toAgentId: outbound.toAgentId,
            correlationId: outbound.correlationId,
          },
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
          Bus.publish(Operational.Debug, {
            traceId,
            time: Date.now(),
            component: "messenger:send",
            msg: "messenger envelope delivered",
            context: {
              envelopeId: outbound.id,
              fromAgentId: outbound.fromAgentId,
              toAgentId: outbound.toAgentId,
            },
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
          Bus.publish(Operational.Warn, {
            traceId,
            time: Date.now(),
            component: "messenger:send",
            msg: "messenger delivery failed",
            context: {
              envelopeId: outbound.id,
              reason,
            },
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
        Bus.publish(Operational.Debug, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "messenger:subscribe",
          msg: "messenger subscribe registered",
          context: { agentId },
        });
        return transport.subscribe(agentId, (env) => {
          Bus.publish(Operational.Debug, {
            traceId: env.traceId || crypto.randomUUID(),
            time: Date.now(),
            component: "messenger:subscribe",
            msg: "messenger envelope received",
            context: {
              envelopeId: env.id,
              fromAgentId: env.fromAgentId,
              toAgentId: env.toAgentId,
            },
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
            const traceId = envelope.traceId || crypto.randomUUID();
            Bus.publish(Operational.Warn, {
              traceId,
              time: Date.now(),
              component: "messenger:request",
              msg: "messenger request timed out",
              context: {
                envelopeId: envelope.id,
                fromAgentId: envelope.fromAgentId,
                toAgentId: envelope.toAgentId,
                timeoutMs: reqOptions.timeout,
              },
            });
            reject(new Error(`Request timed out after ${reqOptions.timeout}ms`));
          }, reqOptions.timeout);

          const unsub = transport.subscribe(envelope.fromAgentId, (response) => {
            if (response.correlationId === correlationId) {
              clearTimeout(timer);
              unsub();
              const traceId = response.traceId || crypto.randomUUID();
              Bus.publish(Operational.Debug, {
                traceId,
                time: Date.now(),
                component: "messenger:request",
                msg: "messenger request response received",
                context: {
                  envelopeId: response.id,
                  correlationId,
                  fromAgentId: response.fromAgentId,
                },
              });
              resolve(response);
            }
          });

          if (reqOptions.signal) {
            reqOptions.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              unsub();
              const traceId = envelope.traceId || crypto.randomUUID();
              Bus.publish(Operational.Warn, {
                traceId,
                time: Date.now(),
                component: "messenger:request",
                msg: "messenger request aborted",
                context: {
                  envelopeId: envelope.id,
                },
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
    return getDefaultContext().messageLog.getLog();
  }

  export function _resetLog(): void {
    getDefaultContext().messageLog.reset();
  }
}
