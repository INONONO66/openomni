import { describe, it, expect } from "bun:test";
import { randomUUID } from "crypto";
import {
  type MessageEnvelope,
  type PersistencePolicy,
  type AuditMetadata,
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
  payload: { payload: "ping" },
  ...overrides,
});

describe("PersistencePolicy", () => {
  it("accepts 'asker_only' as valid policy", () => {
    const policy: PersistencePolicy = "asker_only";
    expect(policy).toBe("asker_only");
  });

  it("accepts 'both' as valid policy", () => {
    const policy: PersistencePolicy = "both";
    expect(policy).toBe("both");
  });

  it("accepts 'none' as valid policy", () => {
    const policy: PersistencePolicy = "none";
    expect(policy).toBe("none");
  });
});

describe("AuditMetadata", () => {
  it("contains all required fields", () => {
    const metadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "request",
      timestamp: new Date().toISOString(),
      status: "sent",
    };

    expect(metadata.traceId).toBeDefined();
    expect(metadata.fromAgentId).toBeDefined();
    expect(metadata.toAgentId).toBeDefined();
    expect(metadata.direction).toBe("request");
    expect(metadata.timestamp).toBeDefined();
    expect(metadata.status).toBe("sent");
  });

  it("accepts optional latencyMs field", () => {
    const metadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "response",
      timestamp: new Date().toISOString(),
      status: "delivered",
      latencyMs: 150,
    };

    expect(metadata.latencyMs).toBe(150);
  });

  it("accepts 'request' and 'response' directions", () => {
    const requestMetadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "request",
      timestamp: new Date().toISOString(),
      status: "sent",
    };

    const responseMetadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "response",
      timestamp: new Date().toISOString(),
      status: "delivered",
    };

    expect(requestMetadata.direction).toBe("request");
    expect(responseMetadata.direction).toBe("response");
  });

  it("accepts 'sent', 'delivered', 'failed' statuses", () => {
    const sentMetadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "request",
      timestamp: new Date().toISOString(),
      status: "sent",
    };

    const deliveredMetadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "response",
      timestamp: new Date().toISOString(),
      status: "delivered",
    };

    const failedMetadata: AuditMetadata = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "request",
      timestamp: new Date().toISOString(),
      status: "failed",
    };

    expect(sentMetadata.status).toBe("sent");
    expect(deliveredMetadata.status).toBe("delivered");
    expect(failedMetadata.status).toBe("failed");
  });
});

describe("AuditEntry", () => {
  it("combines AuditMetadata with messageId and type", () => {
    const entry: AuditEntry = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "request",
      timestamp: new Date().toISOString(),
      status: "sent",
      messageId: randomUUID(),
      type: "agent.request",
    };

    expect(entry.traceId).toBeDefined();
    expect(entry.messageId).toBeDefined();
    expect(entry.type).toBe("agent.request");
  });

  it("does not include payload field", () => {
    const entry: AuditEntry = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "response",
      timestamp: new Date().toISOString(),
      status: "delivered",
      messageId: randomUUID(),
      type: "agent.response",
    };

    expect("payload" in entry).toBe(false);
  });

  it("supports optional latencyMs from AuditMetadata", () => {
    const entry: AuditEntry = {
      traceId: randomUUID(),
      fromAgentId: randomUUID(),
      toAgentId: randomUUID(),
      direction: "request",
      timestamp: new Date().toISOString(),
      status: "sent",
      latencyMs: 250,
      messageId: randomUUID(),
      type: "agent.request",
    };

    expect(entry.latencyMs).toBe(250);
  });
});

describe("MessageEnvelope with persistencePolicy", () => {
  it("persistencePolicy field is optional (backward compatible)", () => {
    const envelope = createEnvelope();
    expect(envelope.persistencePolicy).toBeUndefined();
  });

  it("accepts persistencePolicy when provided", () => {
    const envelope = createEnvelope({ persistencePolicy: "asker_only" });
    expect(envelope.persistencePolicy).toBe("asker_only");
  });

  it("preserves all existing fields when persistencePolicy is added", () => {
    const envelope = createEnvelope({ persistencePolicy: "both" });
    expect(envelope.traceId).toBeDefined();
    expect(envelope.sessionId).toBeDefined();
    expect(envelope.runId).toBeDefined();
    expect(envelope.fromAgentId).toBeDefined();
    expect(envelope.toAgentId).toBeDefined();
    expect(envelope.sentAt).toBeDefined();
    expect(envelope.schemaRef).toBeDefined();
    expect(envelope.payload).toBeDefined();
    expect(envelope.persistencePolicy).toBe("both");
  });

  it("supports all persistence policy values", () => {
    const policies: PersistencePolicy[] = ["asker_only", "both", "none"];

    policies.forEach((policy) => {
      const envelope = createEnvelope({ persistencePolicy: policy });
      expect(envelope.persistencePolicy).toBe(policy);
    });
  });
});
