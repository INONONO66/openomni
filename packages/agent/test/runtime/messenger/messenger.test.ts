import { afterEach, describe, expect, it } from "bun:test";
import { Bus } from "@openomni/session";
import { AgentMessenger, BusTransport } from "../../../src/runtime/messenger/index";
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

describe("AgentMessenger", () => {
  it("delivers message to subscriber", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    const received: Messenger.MessageEnvelope[] = [];
    messenger.subscribe("agent-b", (env) => received.push(env));

    const envelope = makeEnvelope("agent-a", "agent-b");
    await messenger.send(envelope);

    expect(received).toHaveLength(1);
    expect(received[0].fromAgentId).toBe("agent-a");
    expect(received[0].toAgentId).toBe("agent-b");
  });

  it("does not deliver to wrong agent", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    const receivedByC: Messenger.MessageEnvelope[] = [];
    messenger.subscribe("agent-c", (env) => receivedByC.push(env));

    await messenger.send(makeEnvelope("agent-a", "agent-b"));

    expect(receivedByC).toHaveLength(0);
  });

  it("allows message when no allow patterns configured", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    await expect(messenger.send(makeEnvelope("agent-x", "agent-y"))).resolves.toBeUndefined();
  });

  it("allows message matching allow pattern", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });

    await expect(messenger.send(makeEnvelope("agent-a", "agent-b"))).resolves.toBeUndefined();
  });

  it("denies message not matching allow pattern", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "agent-a", to: "agent-b" }],
    });

    await expect(messenger.send(makeEnvelope("agent-c", "agent-b"))).rejects.toThrow(
      "Authorization denied",
    );
  });

  it("allows wildcard * in allow pattern", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "*", to: "*" }],
    });

    await expect(messenger.send(makeEnvelope("any-agent", "any-other"))).resolves.toBeUndefined();
  });

  it("handles 3 concurrent sends without message loss", async () => {
    const transport = new BusTransport();
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

  it("persists persistencePolicy in log", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    await messenger.send(makeEnvelope("a", "b", "asker_only"));
    await messenger.send(makeEnvelope("a", "b", "both"));

    const log = AgentMessenger.getLog();
    expect(log[0].persistencePolicy).toBe("asker_only");
    expect(log[1].persistencePolicy).toBe("both");
  });

  it("unsubscribe stops delivery", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    const received: Messenger.MessageEnvelope[] = [];
    const unsub = messenger.subscribe("agent-b", (env) => received.push(env));

    await messenger.send(makeEnvelope("agent-a", "agent-b"));
    unsub();
    await messenger.send(makeEnvelope("agent-a", "agent-b"));

    expect(received).toHaveLength(1);
  });

  it("rotates log when MAX_LOG_SIZE is reached", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    for (let i = 0; i < 1001; i++) {
      await messenger.send(makeEnvelope("agent-a", "agent-b"));
    }

    const log = AgentMessenger.getLog();
    expect(log.length).toBeLessThan(1000);
    expect(log.length).toBe(501);
  });
});
