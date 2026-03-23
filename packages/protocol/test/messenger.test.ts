import { describe, test, expect } from "bun:test";
import { Messenger } from "../src/messenger/index.js";

describe("Messenger.MessageEnvelopeSchema", () => {
  test("should parse valid MessageEnvelope", () => {
    const envelope = Messenger.MessageEnvelopeSchema.parse({
      id: "msg-1",
      traceId: "trace-123",
      correlationId: "corr-456",
      sessionId: "session-789",
      runId: "run-abc",
      fromAgentId: "agent-explore",
      toAgentId: "agent-implement",
      sentAt: "2026-03-23T10:30:00Z",
      schemaRef: "schema/task-request",
      payload: { task: "implement feature X" },
      persistencePolicy: "both",
    });

    expect(envelope.id).toBe("msg-1");
    expect(envelope.traceId).toBe("trace-123");
    expect(envelope.correlationId).toBe("corr-456");
    expect(envelope.sessionId).toBe("session-789");
    expect(envelope.runId).toBe("run-abc");
    expect(envelope.fromAgentId).toBe("agent-explore");
    expect(envelope.toAgentId).toBe("agent-implement");
    expect(envelope.sentAt).toBe("2026-03-23T10:30:00Z");
    expect(envelope.schemaRef).toBe("schema/task-request");
    expect(envelope.payload).toEqual({ task: "implement feature X" });
    expect(envelope.persistencePolicy).toBe("both");
  });

  test("should parse MessageEnvelope with null correlationId", () => {
    const envelope = Messenger.MessageEnvelopeSchema.parse({
      id: "msg-2",
      traceId: "trace-456",
      correlationId: null,
      sessionId: "session-789",
      runId: "run-def",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      sentAt: "2026-03-23T11:00:00Z",
      schemaRef: "schema/notification",
      payload: { event: "task-completed" },
      persistencePolicy: "asker_only",
    });

    expect(envelope.correlationId).toBeNull();
    expect(envelope.persistencePolicy).toBe("asker_only");
  });

  test("should reject invalid persistencePolicy", () => {
    expect(() => {
      Messenger.MessageEnvelopeSchema.parse({
        id: "msg-3",
        traceId: "trace-789",
        correlationId: null,
        sessionId: "session-789",
        runId: "run-ghi",
        fromAgentId: "agent-x",
        toAgentId: "agent-y",
        sentAt: "2026-03-23T12:00:00Z",
        schemaRef: "schema/test",
        payload: {},
        persistencePolicy: "invalid_policy",
      });
    }).toThrow();
  });

  test("should accept unknown payload types", () => {
    const envelope1 = Messenger.MessageEnvelopeSchema.parse({
      id: "msg-4",
      traceId: "trace-abc",
      correlationId: null,
      sessionId: "session-789",
      runId: "run-jkl",
      fromAgentId: "agent-p",
      toAgentId: "agent-q",
      sentAt: "2026-03-23T13:00:00Z",
      schemaRef: "schema/string",
      payload: "string payload",
      persistencePolicy: "both",
    });
    expect(envelope1.payload).toBe("string payload");

    const envelope2 = Messenger.MessageEnvelopeSchema.parse({
      id: "msg-5",
      traceId: "trace-def",
      correlationId: null,
      sessionId: "session-789",
      runId: "run-mno",
      fromAgentId: "agent-r",
      toAgentId: "agent-s",
      sentAt: "2026-03-23T14:00:00Z",
      schemaRef: "schema/array",
      payload: [1, 2, 3],
      persistencePolicy: "asker_only",
    });
    expect(envelope2.payload).toEqual([1, 2, 3]);
  });
});

describe("Messenger.PersistencePolicy", () => {
  test("should parse valid persistence policies", () => {
    expect(Messenger.PersistencePolicy.parse("asker_only")).toBe("asker_only");
    expect(Messenger.PersistencePolicy.parse("both")).toBe("both");
  });

  test("should reject invalid persistence policies", () => {
    expect(() => Messenger.PersistencePolicy.parse("invalid")).toThrow();
    expect(() => Messenger.PersistencePolicy.parse("sender_only")).toThrow();
  });
});

describe("Messenger.AllowPattern", () => {
  test("should parse valid AllowPattern", () => {
    const pattern = Messenger.AllowPattern.parse({
      from: "agent-explore",
      to: "agent-implement",
    });
    expect(pattern.from).toBe("agent-explore");
    expect(pattern.to).toBe("agent-implement");
  });

  test("should parse AllowPattern with wildcard from", () => {
    const pattern = Messenger.AllowPattern.parse({
      from: "*",
      to: "agent-implement",
    });
    expect(pattern.from).toBe("*");
    expect(pattern.to).toBe("agent-implement");
  });

  test("should parse AllowPattern with wildcard to", () => {
    const pattern = Messenger.AllowPattern.parse({
      from: "agent-explore",
      to: "*",
    });
    expect(pattern.from).toBe("agent-explore");
    expect(pattern.to).toBe("*");
  });

  test("should parse AllowPattern with both wildcards", () => {
    const pattern = Messenger.AllowPattern.parse({
      from: "*",
      to: "*",
    });
    expect(pattern.from).toBe("*");
    expect(pattern.to).toBe("*");
  });

  test("should reject AllowPattern with missing fields", () => {
    expect(() => Messenger.AllowPattern.parse({ from: "agent-a" })).toThrow();
    expect(() => Messenger.AllowPattern.parse({ to: "agent-b" })).toThrow();
  });
});

describe("Messenger.AuditEntry", () => {
  test("should parse valid AuditEntry", () => {
    const entry = Messenger.AuditEntry.parse({
      id: "audit-1",
      envelopeId: "msg-1",
      agentId: "agent-explore",
      action: "send",
      timestamp: "2026-03-23T10:30:00Z",
    });

    expect(entry.id).toBe("audit-1");
    expect(entry.envelopeId).toBe("msg-1");
    expect(entry.agentId).toBe("agent-explore");
    expect(entry.action).toBe("send");
    expect(entry.timestamp).toBe("2026-03-23T10:30:00Z");
  });

  test("should parse AuditEntry with different actions", () => {
    const actions = ["send", "receive", "read", "delete"];
    for (const action of actions) {
      const entry = Messenger.AuditEntry.parse({
        id: `audit-${action}`,
        envelopeId: "msg-1",
        agentId: "agent-test",
        action,
        timestamp: "2026-03-23T10:30:00Z",
      });
      expect(entry.action).toBe(action);
    }
  });

  test("should reject AuditEntry with missing fields", () => {
    expect(() =>
      Messenger.AuditEntry.parse({
        id: "audit-1",
        envelopeId: "msg-1",
        agentId: "agent-test",
      }),
    ).toThrow();
  });
});
