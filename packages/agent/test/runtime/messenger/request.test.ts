import { afterEach, describe, expect, it } from "bun:test";
import { Bus } from "@openomni/session";
import { AgentMessenger } from "../../../src/runtime/messenger/messenger";
import { BusTransport } from "../../../src/runtime/messenger/transport";
import type { Messenger } from "@openomni/protocol";

function makeEnvelope(from: string, to: string, id?: string): Messenger.MessageEnvelope {
  return {
    id: id ?? crypto.randomUUID(),
    traceId: "trace-1",
    correlationId: null,
    sessionId: "sess-1",
    runId: "run-1",
    fromAgentId: from,
    toAgentId: to,
    sentAt: new Date().toISOString(),
    schemaRef: "text",
    payload: "request",
    persistencePolicy: "both",
  };
}

afterEach(() => {
  Bus.reset();
  AgentMessenger._resetLog();
});

describe("AgentMessenger.request", () => {
  it("resolves when response with matching correlationId arrives", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    const requestEnvelope = makeEnvelope("agent-a", "agent-b");

    messenger.subscribe("agent-b", async (req) => {
      await messenger.send({
        ...makeEnvelope("agent-b", "agent-a"),
        correlationId: req.id,
        payload: "response",
      });
    });

    const response = await messenger.request(requestEnvelope, {
      timeout: 2000,
    });
    expect(response.correlationId).toBe(requestEnvelope.id);
    expect(response.payload).toBe("response");
  });

  it("rejects with timeout when no response arrives", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    const requestEnvelope = makeEnvelope("agent-a", "agent-b");

    await expect(messenger.request(requestEnvelope, { timeout: 50 })).rejects.toThrow("timed out");
  });

  it("rejects when aborted via signal", async () => {
    const transport = new BusTransport();
    const messenger = AgentMessenger.create(transport);

    const controller = new AbortController();
    const requestEnvelope = makeEnvelope("agent-a", "agent-b");

    const promise = messenger.request(requestEnvelope, {
      timeout: 5000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toThrow("aborted");
  });
});
