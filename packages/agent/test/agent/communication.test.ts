import { describe, it, expect, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import {
  AgentMessenger,
  MessagingError,
  type MessageEnvelope,
} from "../../src/agent/communication";

const createEnvelope = (
  overrides: Partial<MessageEnvelope> = {},
): MessageEnvelope => ({
  traceId: randomUUID(),
  sessionId: randomUUID(),
  runId: randomUUID(),
  fromAgentId: randomUUID(),
  toAgentId: randomUUID(),
  sentAt: new Date().toISOString(),
  schemaRef: "test.schema.v1",
  payload: { payload: "ping" },
  ...overrides,
});

describe("AgentMessenger", () => {
  let baseEnvelope: MessageEnvelope;

  beforeEach(() => {
    baseEnvelope = createEnvelope();
    AgentMessenger.resetBothPolicy();
  });

  it("send delivers message to recipient inbox", async () => {
    AgentMessenger.enableBothPolicy();
    const recipient = `agent-${randomUUID()}`;
    const envelope = createEnvelope({
      toAgentId: recipient,
      persistencePolicy: "both",
    });
    const setCalls: Array<{ key: unknown; value: unknown }> = [];
    const originalSet = Map.prototype.set;

    Map.prototype.set = function (key, value) {
      setCalls.push({ key, value });
      return originalSet.call(this, key, value);
    };

    try {
      await AgentMessenger.send(envelope);
    } finally {
      Map.prototype.set = originalSet;
    }

    const inboxWrite = setCalls.find((call) => call.key === recipient);
    expect(inboxWrite).toBeDefined();
    expect(Array.isArray(inboxWrite?.value)).toBe(true);
    expect(inboxWrite?.value as MessageEnvelope[]).toContain(envelope);
  });

  it("send notifies subscribers", async () => {
    const recipient = `agent-${randomUUID()}`;
    const envelope = createEnvelope({ toAgentId: recipient });
    const received: MessageEnvelope[] = [];
    const unsubscribe = AgentMessenger.subscribe(recipient, (message) => {
      received.push(message);
    });

    await AgentMessenger.send(envelope);
    unsubscribe();

    expect(received).toEqual([envelope]);
  });

  it("subscribe returns unsubscribe function", () => {
    const recipient = `agent-${randomUUID()}`;
    const unsubscribe = AgentMessenger.subscribe(recipient, () => undefined);

    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  it("unsubscribe removes handler", async () => {
    const recipient = `agent-${randomUUID()}`;
    const envelope = createEnvelope({ toAgentId: recipient });
    let called = false;
    const unsubscribe = AgentMessenger.subscribe(recipient, () => {
      called = true;
    });

    unsubscribe();
    await AgentMessenger.send(envelope);

    expect(called).toBe(false);
  });

  it("request sends message with correlationId", async () => {
    const from = `agent-${randomUUID()}`;
    const to = `agent-${randomUUID()}`;
    let captureUnsubscribe: (() => void) | null = null;
    const captured = new Promise<MessageEnvelope>((resolve) => {
      captureUnsubscribe = AgentMessenger.subscribe(to, (message) => {
        captureUnsubscribe?.();
        resolve(message);
      });
    });

    const requestPromise = AgentMessenger.request(
      createEnvelope({
        fromAgentId: from,
        toAgentId: to,
        traceId: "preset",
      }),
      { timeoutMs: 250 },
    );

    const requestMessage = await captured;

    await AgentMessenger.send(
      createEnvelope({
        fromAgentId: to,
        toAgentId: from,
        traceId: requestMessage.traceId,
      }),
    );

    await requestPromise;

    expect(typeof requestMessage.traceId).toBe("string");
    expect(requestMessage.traceId.length > 0).toBe(true);
    expect(requestMessage.traceId).not.toBe("preset");
  });

  it("request resolves when reply received", async () => {
    const from = `agent-${randomUUID()}`;
    const to = `agent-${randomUUID()}`;
    let captureUnsubscribe: (() => void) | null = null;
    const captured = new Promise<MessageEnvelope>((resolve) => {
      captureUnsubscribe = AgentMessenger.subscribe(to, (message) => {
        captureUnsubscribe?.();
        resolve(message);
      });
    });

    const requestPromise = AgentMessenger.request(
      createEnvelope({ fromAgentId: from, toAgentId: to }),
      { timeoutMs: 250 },
    );

    const requestMessage = await captured;
    const reply = createEnvelope({
      fromAgentId: to,
      toAgentId: from,
      traceId: requestMessage.traceId,
    });

    await AgentMessenger.send(reply);

    return expect(requestPromise).resolves.toEqual(reply);
  });

  it("request rejects on timeout", async () => {
    const envelope = {
      ...baseEnvelope,
      fromAgentId: `agent-${randomUUID()}`,
      toAgentId: `agent-${randomUUID()}`,
    };

    return expect(
      AgentMessenger.request(envelope, { timeoutMs: 10 }),
    ).rejects.toThrow(MessagingError);
  });

  it("request rejects on send error", async () => {
    const invalidEnvelope = createEnvelope({
      toAgentId: "",
    });

    return expect(AgentMessenger.request(invalidEnvelope)).rejects.toThrow(
      MessagingError,
    );
  });

  it("Invalid envelope throws MessagingError", async () => {
    const invalidEnvelope = {
      ...baseEnvelope,
      payload: undefined,
    };

    return expect(AgentMessenger.send(invalidEnvelope)).rejects.toThrow(
      MessagingError,
    );
  });

  it("Multiple subscribers all receive message", async () => {
    const recipient = `agent-${randomUUID()}`;
    const envelope = createEnvelope({ toAgentId: recipient });
    const received: MessageEnvelope[] = [];

    const unsubscribeOne = AgentMessenger.subscribe(recipient, (message) => {
      received.push(message);
    });
    const unsubscribeTwo = AgentMessenger.subscribe(recipient, (message) => {
      received.push(message);
    });

    await AgentMessenger.send(envelope);

    unsubscribeOne();
    unsubscribeTwo();

    expect(received).toEqual([envelope, envelope]);
  });
});
