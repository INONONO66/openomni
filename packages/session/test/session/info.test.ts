import { describe, expect, test } from "bun:test";
import { SessionInfo } from "../../src/session/info";

describe("SessionInfo schema", () => {
  test("parses old format (backward compatibility)", () => {
    const oldFormat = {
      id: "session-1",
      title: "My Session",
      model: { providerID: "anthropic", modelID: "claude-3-sonnet" },
      time: { created: 1000, updated: 2000 },
    };

    const result = SessionInfo.safeParse(oldFormat);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("session-1");
      expect(result.data.title).toBe("My Session");
      expect(result.data.agent).toBeUndefined();
      expect(result.data.tokens).toBeUndefined();
      expect(result.data.messageCount).toBeUndefined();
      expect(result.data.summary).toBeUndefined();
      expect(result.data.projectId).toBeUndefined();
      expect(result.data.time.archived).toBeUndefined();
    }
  });

  test("parses full format with all new fields", () => {
    const fullFormat = {
      id: "session-2",
      title: "Full Session",
      model: { providerID: "openai", modelID: "gpt-4" },
      time: {
        created: 1000,
        updated: 2000,
        archived: 3000,
      },
      expiresAt: 4000,
      agent: { id: "agent-1", name: "Research Agent" },
      tokens: { input: 100, output: 50, total: 150 },
      messageCount: 5,
      summary: "Session summary text",
      projectId: "proj-123",
    };

    const result = SessionInfo.safeParse(fullFormat);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("session-2");
      expect(result.data.agent?.id).toBe("agent-1");
      expect(result.data.agent?.name).toBe("Research Agent");
      expect(result.data.tokens?.input).toBe(100);
      expect(result.data.tokens?.output).toBe(50);
      expect(result.data.tokens?.total).toBe(150);
      expect(result.data.messageCount).toBe(5);
      expect(result.data.summary).toBe("Session summary text");
      expect(result.data.projectId).toBe("proj-123");
      expect(result.data.time.archived).toBe(3000);
    }
  });

  test("parses partial format with some new fields", () => {
    const partialFormat = {
      id: "session-3",
      title: "Partial Session",
      model: { providerID: "anthropic", modelID: "claude-3-opus" },
      time: { created: 1000, updated: 2000 },
      agent: { id: "agent-2" },
      messageCount: 3,
    };

    const result = SessionInfo.safeParse(partialFormat);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent?.id).toBe("agent-2");
      expect(result.data.agent?.name).toBeUndefined();
      expect(result.data.messageCount).toBe(3);
      expect(result.data.tokens).toBeUndefined();
      expect(result.data.summary).toBeUndefined();
      expect(result.data.projectId).toBeUndefined();
    }
  });

  test("infers correct TypeScript types", () => {
    const session: SessionInfo = {
      id: "session-4",
      title: "Type Test",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 1000, updated: 2000 },
    };

    expect(session.id).toBe("session-4");
    expect(session.agent).toBeUndefined();
    expect(session.tokens).toBeUndefined();
  });

  test("validates agent object structure", () => {
    const invalidAgent = {
      id: "session-5",
      title: "Invalid Agent",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 1000, updated: 2000 },
      agent: { id: 123 },
    };

    const result = SessionInfo.safeParse(invalidAgent);
    expect(result.success).toBe(false);
  });

  test("validates tokens object structure", () => {
    const invalidTokens = {
      id: "session-6",
      title: "Invalid Tokens",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 1000, updated: 2000 },
      tokens: { input: "100", output: 50, total: 150 },
    };

    const result = SessionInfo.safeParse(invalidTokens);
    expect(result.success).toBe(false);
  });

  test("allows expiresAt with new fields", () => {
    const withExpiry = {
      id: "session-7",
      title: "With Expiry",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 1000, updated: 2000 },
      expiresAt: 5000,
      agent: { id: "agent-3" },
      tokens: { input: 10, output: 5, total: 15 },
    };

    const result = SessionInfo.safeParse(withExpiry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiresAt).toBe(5000);
      expect(result.data.agent?.id).toBe("agent-3");
    }
  });
});
