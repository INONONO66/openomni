import { describe, it, expect, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import {
  AgentMessenger,
  MessagingError,
  type MessageEnvelope,
  type AuditEntry,
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
  payload: { data: "test" },
  ...overrides,
});

describe("AgentMessenger A2A Persistence", () => {
  let sender: string;
  let receiver: string;

  beforeEach(() => {
    sender = `agent-${randomUUID()}`;
    receiver = `agent-${randomUUID()}`;
  });

  describe("asker_only policy (default)", () => {
    it("stores full envelope in sender inbox", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
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

      const senderInbox = setCalls.find((call) => call.key === sender);
      expect(senderInbox).toBeDefined();
      expect(Array.isArray(senderInbox?.value)).toBe(true);
      const senderMessages = senderInbox?.value as MessageEnvelope[];
      expect(senderMessages).toContain(envelope);
      expect(senderMessages[0]?.payload).toEqual({ data: "test" });
    });

    it("stores audit entry only in receiver inbox", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await AgentMessenger.send(envelope);

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit.length).toBe(1);
      expect(receiverAudit[0]?.messageId).toBe(envelope.runId);
      expect(receiverAudit[0]?.type).toBe(envelope.schemaRef);
      expect(receiverAudit[0]?.traceId).toBe(envelope.traceId);
      expect(receiverAudit[0]?.fromAgentId).toBe(sender);
      expect(receiverAudit[0]?.toAgentId).toBe(receiver);
      expect(receiverAudit[0]?.direction).toBe("request");
      expect(receiverAudit[0]?.status).toBe("delivered");
    });

    it("defaults to asker_only when persistencePolicy is undefined", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: undefined,
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

      const senderInbox = setCalls.find((call) => call.key === sender);
      expect(senderInbox).toBeDefined();

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit.length).toBe(1);
    });

    it("explicitly setting asker_only works correctly", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "asker_only",
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

      const senderInbox = setCalls.find((call) => call.key === sender);
      expect(senderInbox).toBeDefined();

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit.length).toBe(1);
    });
  });

  describe("both policy", () => {
    it("stores full envelope in both sender and receiver inboxes", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
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

      const senderInbox = setCalls.find((call) => call.key === sender);
      expect(senderInbox).toBeDefined();
      expect(Array.isArray(senderInbox?.value)).toBe(true);
      const senderMessages = senderInbox?.value as MessageEnvelope[];
      expect(senderMessages).toContain(envelope);

      const receiverInbox = setCalls.find((call) => call.key === receiver);
      expect(receiverInbox).toBeDefined();
      expect(Array.isArray(receiverInbox?.value)).toBe(true);
      const receiverMessages = receiverInbox?.value as MessageEnvelope[];
      expect(receiverMessages).toContain(envelope);
    });

    it("both inboxes contain full payload", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "both",
        payload: { important: "data", nested: { value: 42 } },
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

      const senderInbox = setCalls.find((call) => call.key === sender);
      const senderMessages = senderInbox?.value as MessageEnvelope[];
      expect(senderMessages[0]?.payload).toEqual({
        important: "data",
        nested: { value: 42 },
      });

      const receiverInbox = setCalls.find((call) => call.key === receiver);
      const receiverMessages = receiverInbox?.value as MessageEnvelope[];
      expect(receiverMessages[0]?.payload).toEqual({
        important: "data",
        nested: { value: 42 },
      });
    });
  });

  describe("none policy", () => {
    it("stores audit entry only in both sender and receiver", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "none",
      });

      await AgentMessenger.send(envelope);

      const senderAudit = AgentMessenger.getAuditLog(sender);
      expect(senderAudit.length).toBe(1);
      expect(senderAudit[0]?.messageId).toBe(envelope.runId);

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit.length).toBe(1);
      expect(receiverAudit[0]?.messageId).toBe(envelope.runId);
    });

    it("audit entries do not contain payload", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "none",
        payload: { secret: "data" },
      });

      await AgentMessenger.send(envelope);

      const senderAudit = AgentMessenger.getAuditLog(sender);
      expect(senderAudit[0]).not.toHaveProperty("payload");

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit[0]).not.toHaveProperty("payload");
    });
  });

  describe("getAuditLog", () => {
    it("returns empty array for agent with no audit entries", () => {
      const unknownAgent = `agent-${randomUUID()}`;
      const audit = AgentMessenger.getAuditLog(unknownAgent);
      expect(audit).toEqual([]);
    });

    it("returns all audit entries for an agent", async () => {
      const envelope1 = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "asker_only",
      });
      const envelope2 = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "asker_only",
      });

      await AgentMessenger.send(envelope1);
      await AgentMessenger.send(envelope2);

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit.length).toBe(2);
      expect(receiverAudit[0]?.messageId).toBe(envelope1.runId);
      expect(receiverAudit[1]?.messageId).toBe(envelope2.runId);
    });

    it("audit entries contain all required metadata fields", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "none",
      });

      await AgentMessenger.send(envelope);

      const audit = AgentMessenger.getAuditLog(sender);
      expect(audit.length).toBe(1);

      const entry = audit[0] as AuditEntry;
      expect(entry.messageId).toBe(envelope.runId);
      expect(entry.type).toBe(envelope.schemaRef);
      expect(entry.traceId).toBe(envelope.traceId);
      expect(entry.fromAgentId).toBe(sender);
      expect(entry.toAgentId).toBe(receiver);
      expect(entry.direction).toBe("request");
      expect(entry.timestamp).toBe(envelope.sentAt);
      expect(entry.status).toBe("delivered");
    });
  });

  describe("subscriber notification behavior", () => {
    it("subscribers receive full envelope regardless of persistence policy", async () => {
      const received: MessageEnvelope[] = [];
      const unsubscribe = AgentMessenger.subscribe(receiver, (message) => {
        received.push(message);
      });

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "asker_only",
        payload: { sensitive: "data" },
      });

      await AgentMessenger.send(envelope);
      unsubscribe();

      expect(received.length).toBe(1);
      expect(received[0]).toEqual(envelope);
      expect(received[0]?.payload).toEqual({ sensitive: "data" });
    });

    it("subscribers receive full envelope with none policy", async () => {
      const received: MessageEnvelope[] = [];
      const unsubscribe = AgentMessenger.subscribe(receiver, (message) => {
        received.push(message);
      });

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
        persistencePolicy: "none",
        payload: { important: "notification" },
      });

      await AgentMessenger.send(envelope);
      unsubscribe();

      expect(received.length).toBe(1);
      expect(received[0]).toEqual(envelope);
      expect(received[0]?.payload).toEqual({ important: "notification" });
    });
  });
});

describe("AgentMessenger Allow Pattern Gate", () => {
  let sender: string;
  let receiver: string;

  beforeEach(() => {
    sender = `agent-${randomUUID()}`;
    receiver = `agent-${randomUUID()}`;
    AgentMessenger.resetAllowPatterns();
  });

  describe("default behavior (no patterns configured)", () => {
    it("allows all communication when no patterns are set", async () => {
      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("allows all communication after resetAllowPatterns()", async () => {
      AgentMessenger.configureAllowPatterns([{ from: "nobody", to: "nobody" }]);
      AgentMessenger.resetAllowPatterns();

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });
  });

  describe("allowed communication", () => {
    it("passes through with exact from/to match", async () => {
      AgentMessenger.configureAllowPatterns([{ from: sender, to: receiver }]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("passes through with wildcard source", async () => {
      AgentMessenger.configureAllowPatterns([{ from: "*", to: receiver }]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("passes through with wildcard target", async () => {
      AgentMessenger.configureAllowPatterns([{ from: sender, to: "*" }]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("passes through with wildcard both", async () => {
      AgentMessenger.configureAllowPatterns([{ from: "*", to: "*" }]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("matches any pattern in the list", async () => {
      const otherAgent = `agent-${randomUUID()}`;
      AgentMessenger.configureAllowPatterns([
        { from: otherAgent, to: receiver },
        { from: sender, to: receiver },
      ]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });
  });

  describe("blocked communication", () => {
    it("throws MessagingError when no pattern matches", async () => {
      AgentMessenger.configureAllowPatterns([
        { from: "other-agent", to: "other-target" },
      ]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).rejects.toThrow(
        MessagingError,
      );
    });

    it("includes source and target in error message", async () => {
      AgentMessenger.configureAllowPatterns([]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).rejects.toThrow(
        `Unauthorized: ${sender} -> ${receiver} not allowed`,
      );
    });

    it("blocks when empty patterns array is configured", async () => {
      AgentMessenger.configureAllowPatterns([]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).rejects.toThrow(
        MessagingError,
      );
    });

    it("blocks when source matches but target does not", async () => {
      AgentMessenger.configureAllowPatterns([
        { from: sender, to: "wrong-target" },
      ]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).rejects.toThrow(
        MessagingError,
      );
    });

    it("blocks when target matches but source does not", async () => {
      AgentMessenger.configureAllowPatterns([
        { from: "wrong-source", to: receiver },
      ]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).rejects.toThrow(
        MessagingError,
      );
    });
  });

  describe("audit logging for blocked attempts", () => {
    it("records failed audit entry for sender", async () => {
      AgentMessenger.configureAllowPatterns([]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      try {
        await AgentMessenger.send(envelope);
      } catch {
        // expected
      }

      const senderAudit = AgentMessenger.getAuditLog(sender);
      expect(senderAudit.length).toBe(1);
      expect(senderAudit[0]?.status).toBe("failed");
      expect(senderAudit[0]?.fromAgentId).toBe(sender);
      expect(senderAudit[0]?.toAgentId).toBe(receiver);
      expect(senderAudit[0]?.messageId).toBe(envelope.runId);
    });

    it("records failed audit entry for receiver", async () => {
      AgentMessenger.configureAllowPatterns([]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      try {
        await AgentMessenger.send(envelope);
      } catch {
        // expected
      }

      const receiverAudit = AgentMessenger.getAuditLog(receiver);
      expect(receiverAudit.length).toBe(1);
      expect(receiverAudit[0]?.status).toBe("failed");
      expect(receiverAudit[0]?.fromAgentId).toBe(sender);
      expect(receiverAudit[0]?.toAgentId).toBe(receiver);
    });

    it("does not deliver message or notify subscribers on block", async () => {
      AgentMessenger.configureAllowPatterns([]);
      const received: MessageEnvelope[] = [];
      const unsubscribe = AgentMessenger.subscribe(receiver, (msg) => {
        received.push(msg);
      });

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      try {
        await AgentMessenger.send(envelope);
      } catch {
        // expected
      }

      unsubscribe();
      expect(received.length).toBe(0);
    });
  });

  describe("pattern precedence", () => {
    it("specific pattern allows even when other patterns would not match", async () => {
      AgentMessenger.configureAllowPatterns([
        { from: "other", to: "other" },
        { from: sender, to: receiver },
      ]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("wildcard pattern allows agents not explicitly listed", async () => {
      AgentMessenger.configureAllowPatterns([
        { from: "specific-agent", to: "specific-target" },
        { from: "*", to: "*" },
      ]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).resolves.toBeUndefined();
    });

    it("reconfiguring patterns replaces previous configuration", async () => {
      AgentMessenger.configureAllowPatterns([{ from: sender, to: receiver }]);
      AgentMessenger.configureAllowPatterns([{ from: "other", to: "other" }]);

      const envelope = createEnvelope({
        fromAgentId: sender,
        toAgentId: receiver,
      });

      await expect(AgentMessenger.send(envelope)).rejects.toThrow(
        MessagingError,
      );
    });
  });
});
