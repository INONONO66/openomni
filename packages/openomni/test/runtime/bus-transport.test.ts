import { describe, it, expect, beforeEach } from "bun:test";
import { Bus, Storage } from "@openomni/session";
import { AgentMessenger } from "@openomni/agent";
import { BusTransport } from "../../src/runtime/bus-transport";
import type { Messenger } from "@openomni/protocol";

describe("BusTransport", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("send and subscribe", () => {
    it("delivers envelope to subscribed agent", async () => {
      const transport = new BusTransport();
      const received: Messenger.MessageEnvelope[] = [];

      const unsub = transport.subscribe("agent-b", (env) => {
        received.push(env);
      });

      const envelope: Messenger.MessageEnvelope = {
        id: "env-1",
        traceId: "trace-1",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "hello",
        persistencePolicy: "both",
      };

      await transport.send(envelope);

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("env-1");
      expect(received[0].fromAgentId).toBe("agent-a");
      expect(received[0].toAgentId).toBe("agent-b");

      unsub();
    });

    it("does not deliver to unsubscribed agent", async () => {
      const transport = new BusTransport();
      const received: Messenger.MessageEnvelope[] = [];

      transport.subscribe("agent-c", (env) => {
        received.push(env);
      });

      const envelope: Messenger.MessageEnvelope = {
        id: "env-2",
        traceId: "trace-2",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "hello",
        persistencePolicy: "both",
      };

      await transport.send(envelope);

      expect(received).toHaveLength(0);
    });

    it("unsubscribe stops delivery", async () => {
      const transport = new BusTransport();
      const received: Messenger.MessageEnvelope[] = [];

      const unsub = transport.subscribe("agent-b", (env) => {
        received.push(env);
      });

      const envelope1: Messenger.MessageEnvelope = {
        id: "env-3",
        traceId: "trace-3",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "first",
        persistencePolicy: "both",
      };

      await transport.send(envelope1);
      expect(received).toHaveLength(1);

      unsub();

      const envelope2: Messenger.MessageEnvelope = {
        id: "env-4",
        traceId: "trace-4",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "second",
        persistencePolicy: "both",
      };

      await transport.send(envelope2);
      expect(received).toHaveLength(1);
    });

    it("supports multiple subscribers for same agent", async () => {
      const transport = new BusTransport();
      const received1: Messenger.MessageEnvelope[] = [];
      const received2: Messenger.MessageEnvelope[] = [];

      transport.subscribe("agent-b", (env) => {
        received1.push(env);
      });

      transport.subscribe("agent-b", (env) => {
        received2.push(env);
      });

      const envelope: Messenger.MessageEnvelope = {
        id: "env-5",
        traceId: "trace-5",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "hello",
        persistencePolicy: "both",
      };

      await transport.send(envelope);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });
  });

  describe("raw messenger.envelope event absence", () => {
    it("does not publish raw messenger.envelope to Bus", async () => {
      const transport = new BusTransport();
      const publishedEvents: string[] = [];

      const unobserve = Bus.observe((descriptor) => {
        publishedEvents.push(descriptor.name);
      });

      const envelope: Messenger.MessageEnvelope = {
        id: "env-6",
        traceId: "trace-6",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "hello",
        persistencePolicy: "both",
      };

      const received: Messenger.MessageEnvelope[] = [];
      transport.subscribe("agent-b", (env) => {
        received.push(env);
      });
      await transport.send(envelope);

      // Give async Bus.observe a moment to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      unobserve();

      expect(publishedEvents).not.toContain("messenger.envelope");
    });
  });

  describe("integration with AgentMessenger", () => {
    it("AgentMessenger publishes semantic events through Bus", async () => {
      const transport = new BusTransport();
      const messenger = AgentMessenger.create(transport);
      const publishedEvents: string[] = [];

      const unobserve = Bus.observe((descriptor) => {
        publishedEvents.push(descriptor.name);
      });

      const envelope: Messenger.MessageEnvelope = {
        id: "env-7",
        traceId: "trace-7",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "hello",
        persistencePolicy: "both",
      };

      const received: Messenger.MessageEnvelope[] = [];
      transport.subscribe("agent-b", (env) => {
        received.push(env);
      });
      await messenger.send(envelope);

      // Give async Bus.observe a moment to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      unobserve();

      expect(publishedEvents).toContain("messenger.envelope.created");
      expect(publishedEvents).toContain("messenger.delivered");
      expect(publishedEvents).not.toContain("messenger.envelope");
    });

    it("AgentMessenger publishes delivery failed event on send error", async () => {
      class FailingTransport {
        async send(): Promise<void> {
          throw new Error("Transport failed");
        }

        subscribe(): () => void {
          return () => {
            // no-op unsubscribe for test transport
          };
        }
      }

      const transport = new FailingTransport();
      const messenger = AgentMessenger.create(transport);
      const publishedEvents: string[] = [];

      const unobserve = Bus.observe((descriptor) => {
        publishedEvents.push(descriptor.name);
      });

      const envelope: Messenger.MessageEnvelope = {
        id: "env-8",
        traceId: "trace-8",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "hello",
        persistencePolicy: "both",
      };

      let sendError: Error | null = null;
      try {
        await messenger.send(envelope);
      } catch (err) {
        sendError = err as Error;
      }

      expect(sendError).not.toBeNull();
      expect(sendError?.message).toContain("Transport failed");

      // Give async Bus.observe a moment to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      unobserve();

      expect(publishedEvents).toContain("messenger.envelope.created");
      expect(publishedEvents).toContain("messenger.delivery.failed");
      expect(publishedEvents).not.toContain("messenger.envelope");
    });

    it("AgentMessenger request-response works with BusTransport", async () => {
      const transport = new BusTransport();
      const messengerA = AgentMessenger.create(transport);
      const messengerB = AgentMessenger.create(transport);

      const requestEnvelope: Messenger.MessageEnvelope = {
        id: "env-9",
        traceId: "trace-9",
        correlationId: null,
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "request",
        persistencePolicy: "both",
      };

      const responseEnvelope: Messenger.MessageEnvelope = {
        id: "env-10",
        traceId: "trace-9",
        correlationId: "env-9",
        sessionId: "sess-1",
        runId: "run-1",
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        sentAt: new Date().toISOString(),
        schemaRef: "text",
        payload: "response",
        persistencePolicy: "both",
      };

      messengerB.subscribe("agent-b", async (req) => {
        if (req.id === "env-9") {
          await messengerB.send(responseEnvelope);
        }
      });

      const response = await messengerA.request(requestEnvelope, { timeout: 1000 });

      expect(response.id).toBe("env-10");
      expect(response.payload).toBe("response");
      expect(response.correlationId).toBe("env-9");
    });
  });
});
