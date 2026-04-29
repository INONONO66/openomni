import { describe, expect, it } from "bun:test";
import { AgentMessenger } from "../../../src/runtime/messenger/messenger";
import { queryHistory } from "../../../src/runtime/messenger/history";
import { createAgentRuntimeContext } from "../../../src/core/runtime-context";
import type { Messenger } from "@openomni/protocol";

let nextEnvelopeId = 0;

class HistoryTransport {
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

describe("queryHistory", () => {
  isolatedIt("returns messages visible to the querying agent", async () => {
    const messenger = AgentMessenger.create(new HistoryTransport());
    await messenger.send(makeEnvelope("agent-a", "agent-b", "both"));
    await messenger.send(makeEnvelope("agent-c", "agent-d", "both"));

    const result = queryHistory("agent-b");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].fromAgentId).toBe("agent-a");
  });

  isolatedIt("asker_only: only asker (sender) can see the message", async () => {
    const messenger = AgentMessenger.create(new HistoryTransport());
    await messenger.send(makeEnvelope("agent-a", "agent-b", "asker_only"));

    const resultA = queryHistory("agent-a");
    const resultB = queryHistory("agent-b");

    expect(resultA.messages).toHaveLength(1);
    expect(resultB.messages).toHaveLength(0);
  });

  isolatedIt("both: both sender and receiver can see the message", async () => {
    const messenger = AgentMessenger.create(new HistoryTransport());
    await messenger.send(makeEnvelope("agent-a", "agent-b", "both"));

    const resultA = queryHistory("agent-a");
    const resultB = queryHistory("agent-b");

    expect(resultA.messages).toHaveLength(1);
    expect(resultB.messages).toHaveLength(1);
  });

  isolatedIt("filters by schemaRef", async () => {
    const messenger = AgentMessenger.create(new HistoryTransport());
    const env1 = { ...makeEnvelope("agent-a", "agent-b"), schemaRef: "text" };
    const env2 = { ...makeEnvelope("agent-a", "agent-b"), schemaRef: "json" };
    await messenger.send(env1);
    await messenger.send(env2);

    const result = queryHistory("agent-b", { schemaRef: "text" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].schemaRef).toBe("text");
  });

  isolatedIt("uses an injected runtime context instead of the default log", async () => {
    const context = createAgentRuntimeContext();
    const defaultMessenger = AgentMessenger.create(new HistoryTransport());
    const scopedMessenger = AgentMessenger.create(new HistoryTransport(), { context });

    await defaultMessenger.send({ ...makeEnvelope("agent-a", "agent-b"), payload: "default" });
    await scopedMessenger.send({ ...makeEnvelope("agent-a", "agent-b"), payload: "scoped" });

    const scopedResult = queryHistory("agent-b", {}, context);
    const defaultResult = queryHistory("agent-b");

    expect(scopedResult.messages).toHaveLength(1);
    expect(scopedResult.messages[0].payload).toBe("scoped");
    expect(defaultResult.messages).toHaveLength(1);
    expect(defaultResult.messages[0].payload).toBe("default");
  });

  isolatedIt("paginates with limit and offset", async () => {
    const messenger = AgentMessenger.create(new HistoryTransport());
    for (let i = 0; i < 5; i++) {
      await messenger.send(makeEnvelope("agent-a", "agent-b"));
    }

    const page1 = queryHistory("agent-b", { limit: 2, offset: 0 });
    const page2 = queryHistory("agent-b", { limit: 2, offset: 2 });

    expect(page1.messages).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(5);
    expect(page2.messages).toHaveLength(2);
  });
});
