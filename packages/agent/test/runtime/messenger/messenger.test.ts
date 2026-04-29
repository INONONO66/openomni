import { describe, expect, it } from "bun:test";
import { AgentMessenger } from "../../../src/runtime/messenger/index";
import { createAgentRuntimeContext } from "../../../src/core/runtime-context";
import type { Messenger } from "@openomni/protocol";

let nextEnvelopeId = 0;

class MessengerTransport {
  private handlers: Map<string, ((env: Messenger.MessageEnvelope) => void)[]> = new Map();

  async send(envelope: Messenger.MessageEnvelope): Promise<void> {
    const handlers = this.handlers.get(envelope.toAgentId) ?? [];
    for (const handler of handlers) handler(envelope);
  }

  subscribe(agentId: string, handler: (env: Messenger.MessageEnvelope) => void): () => void {
    const existing = this.handlers.get(agentId) ?? [];
    existing.push(handler);
    this.handlers.set(agentId, existing);
    return () => {
      const handlers = this.handlers.get(agentId) ?? [];
      this.handlers.set(
        agentId,
        handlers.filter((existingHandler) => existingHandler !== handler),
      );
    };
  }
}

function makeEnvelope(
  from: string,
  to: string,
  policy: Messenger.PersistencePolicy = "both",
): Messenger.MessageEnvelope {
  return {
    id: `env-${++nextEnvelopeId}`,
    traceId: "trace-1",
    correlationId: null,
    sessionId: "sess-1",
    runId: "run-1",
    fromAgentId: from,
    toAgentId: to,
    sentAt: new Date().toISOString(),
    schemaRef: "text",
    payload: "hello",
    persistencePolicy: policy,
  };
}

function isolatedIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async () => {
    AgentMessenger._resetLog();
    try {
      await fn();
    } finally {
      AgentMessenger._resetLog();
    }
  });
}

describe("AgentMessenger", () => {
  isolatedIt("delivers message to subscriber", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    const received: Messenger.MessageEnvelope[] = [];
    messenger.subscribe("agent-b", (env) => received.push(env));

    const envelope = makeEnvelope("agent-a", "agent-b");
    await messenger.send(envelope);

    expect(received).toHaveLength(1);
    expect(received[0].fromAgentId).toBe("agent-a");
    expect(received[0].toAgentId).toBe("agent-b");
  });

  isolatedIt("does not deliver to wrong agent", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    const receivedByC: Messenger.MessageEnvelope[] = [];
    messenger.subscribe("agent-c", (env) => receivedByC.push(env));

    await messenger.send(makeEnvelope("agent-a", "agent-b"));

    expect(receivedByC).toHaveLength(0);
  });

  isolatedIt("allows message when no allow patterns configured", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    await expect(messenger.send(makeEnvelope("agent-x", "agent-y"))).resolves.toBeUndefined();
  });

  isolatedIt("allows message matching allow pattern", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });

    await expect(messenger.send(makeEnvelope("agent-a", "agent-b"))).resolves.toBeUndefined();
  });

  isolatedIt("denies message not matching allow pattern", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });

    await expect(messenger.send(makeEnvelope("agent-c", "agent-b"))).rejects.toThrow(
      "Authorization denied",
    );
  });

  isolatedIt("allows wildcard * in allow pattern", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "*", to: "*" }],
    });

    await expect(messenger.send(makeEnvelope("any-agent", "any-other"))).resolves.toBeUndefined();
  });

  isolatedIt("handles 3 concurrent sends without message loss", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    const receivedByB: Messenger.MessageEnvelope[] = [];
    const receivedByC: Messenger.MessageEnvelope[] = [];
    const receivedByA: Messenger.MessageEnvelope[] = [];

    messenger.subscribe("agent-b", (env) => receivedByB.push(env));
    messenger.subscribe("agent-c", (env) => receivedByC.push(env));
    messenger.subscribe("agent-a", (env) => receivedByA.push(env));

    await Promise.all([
      messenger.send(makeEnvelope("agent-a", "agent-b")),
      messenger.send(makeEnvelope("agent-b", "agent-c")),
      messenger.send(makeEnvelope("agent-c", "agent-a")),
    ]);

    expect(receivedByB).toHaveLength(1);
    expect(receivedByC).toHaveLength(1);
    expect(receivedByA).toHaveLength(1);
    expect(AgentMessenger.getLog()).toHaveLength(3);
  });

  isolatedIt("persists persistencePolicy in log", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    await messenger.send(makeEnvelope("a", "b", "asker_only"));
    await messenger.send(makeEnvelope("a", "b", "both"));

    const log = AgentMessenger.getLog();
    expect(log[0].persistencePolicy).toBe("asker_only");
    expect(log[1].persistencePolicy).toBe("both");
  });

  isolatedIt("keeps message logs isolated between runtime contexts", async () => {
    const contextA = createAgentRuntimeContext();
    const contextB = createAgentRuntimeContext();
    const messengerA = AgentMessenger.create(new MessengerTransport(), { context: contextA });
    const messengerB = AgentMessenger.create(new MessengerTransport(), { context: contextB });

    await messengerA.send({ ...makeEnvelope("agent-a", "agent-b"), payload: "from-a" });
    await messengerB.send({ ...makeEnvelope("agent-c", "agent-d"), payload: "from-b" });

    expect(contextA.messageLog.getLog()).toHaveLength(1);
    expect(contextA.messageLog.getLog()[0].payload).toBe("from-a");
    expect(contextB.messageLog.getLog()).toHaveLength(1);
    expect(contextB.messageLog.getLog()[0].payload).toBe("from-b");
    expect(AgentMessenger.getLog()).toHaveLength(0);
  });

  isolatedIt("unsubscribe stops delivery", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    const received: Messenger.MessageEnvelope[] = [];
    const unsub = messenger.subscribe("agent-b", (env) => received.push(env));

    await messenger.send(makeEnvelope("agent-a", "agent-b"));
    unsub();
    await messenger.send(makeEnvelope("agent-a", "agent-b"));

    expect(received).toHaveLength(1);
  });

  isolatedIt("rotates log when MAX_LOG_SIZE is reached", async () => {
    const transport = new MessengerTransport();
    const messenger = AgentMessenger.create(transport);

    for (let i = 0; i < 1001; i++) {
      await messenger.send(makeEnvelope("agent-a", "agent-b"));
    }

    const log = AgentMessenger.getLog();
    expect(log.length).toBeLessThan(1000);
    expect(log.length).toBe(501);
  });
});
