import { afterEach, describe, expect, it } from "bun:test";
import { Bus } from "@openomni/session";
import { AgentMessenger } from "../../../src/runtime/messenger/messenger";
import { BusTransport } from "../../../src/runtime/messenger/transport";
import { queryHistory } from "../../../src/runtime/messenger/history";
import type { Messenger } from "@openomni/protocol";

function makeEnvelope(
  from: string,
  to: string,
  policy: Messenger.PersistencePolicy = "both",
): Messenger.MessageEnvelope {
  return {
    id: crypto.randomUUID(),
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

afterEach(() => {
  Bus.reset();
  AgentMessenger._resetLog();
});

describe("queryHistory", () => {
  it("returns messages visible to the querying agent", async () => {
    const messenger = AgentMessenger.create(new BusTransport());
    await messenger.send(makeEnvelope("agent-a", "agent-b", "both"));
    await messenger.send(makeEnvelope("agent-c", "agent-d", "both"));

    const result = queryHistory("agent-b");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].fromAgentId).toBe("agent-a");
  });

  it("asker_only: only asker (sender) can see the message", async () => {
    const messenger = AgentMessenger.create(new BusTransport());
    await messenger.send(makeEnvelope("agent-a", "agent-b", "asker_only"));

    const resultA = queryHistory("agent-a");
    const resultB = queryHistory("agent-b");

    expect(resultA.messages).toHaveLength(1);
    expect(resultB.messages).toHaveLength(0);
  });

  it("both: both sender and receiver can see the message", async () => {
    const messenger = AgentMessenger.create(new BusTransport());
    await messenger.send(makeEnvelope("agent-a", "agent-b", "both"));

    const resultA = queryHistory("agent-a");
    const resultB = queryHistory("agent-b");

    expect(resultA.messages).toHaveLength(1);
    expect(resultB.messages).toHaveLength(1);
  });

  it("filters by schemaRef", async () => {
    const messenger = AgentMessenger.create(new BusTransport());
    const env1 = { ...makeEnvelope("agent-a", "agent-b"), schemaRef: "text" };
    const env2 = { ...makeEnvelope("agent-a", "agent-b"), schemaRef: "json" };
    await messenger.send(env1);
    await messenger.send(env2);

    const result = queryHistory("agent-b", { schemaRef: "text" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].schemaRef).toBe("text");
  });

  it("paginates with limit and offset", async () => {
    const messenger = AgentMessenger.create(new BusTransport());
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
