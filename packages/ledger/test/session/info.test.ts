import { describe, expect, test } from "bun:test";
import { SessionInfo } from "../../src/session/info";

const base = {
  model: { providerID: "test", modelID: "test-model" },
  time: { created: 1000, updated: 2000 },
};

describe("SessionInfo schema", () => {
  test("defaults legacy optional fields", () => {
    const result = SessionInfo.parse({ ...base, id: "session-1", title: "My Session" });
    expect(result).toMatchObject({ id: "session-1", title: "My Session", spawnDepth: 0 });
    for (const field of ["agent", "tokens", "messageCount", "summary", "projectId", "parentSessionId", "workerMeta"] as const) {
      expect(result[field]).toBeUndefined();
    }
    expect(result.time.archived).toBeUndefined();
  });

  test("parses the complete persisted shape", () => {
    const result = SessionInfo.parse({
      ...base,
      id: "session-2",
      title: "Full Session",
      model: { providerID: "openai", modelID: "gpt-4" },
      time: { ...base.time, archived: 3000 },
      expiresAt: 4000,
      parentSessionId: "parent-1",
      spawnDepth: 2,
      agent: { id: "agent-1", name: "Research Agent" },
      tokens: { input: 100, output: 50, total: 150 },
      messageCount: 5,
      summary: "Session summary text",
      projectId: "proj-123",
      workerMeta: { kind: "worker", lane: "analysis" },
    });
    expect(result).toMatchObject({
      id: "session-2",
      agent: { id: "agent-1", name: "Research Agent" },
      tokens: { input: 100, output: 50, total: 150 },
      messageCount: 5,
      summary: "Session summary text",
      projectId: "proj-123",
      parentSessionId: "parent-1",
      spawnDepth: 2,
      workerMeta: { kind: "worker", lane: "analysis" },
      time: { archived: 3000 },
      expiresAt: 4000,
    });
  });

  for (const row of [
    {
      id: "session-7",
      title: "With Expiry",
      expiresAt: 5000,
      agent: { id: "agent-3" },
      tokens: { input: 10, output: 5, total: 15 },
    },
  ]) {
    test("allows expiresAt with new fields", () => {
      const result = SessionInfo.parse({ ...base, ...row });
      expect(result.expiresAt).toBe(5000);
      expect(result.agent?.id).toBe("agent-3");
      expect(result.tokens).toEqual({ input: 10, output: 5, total: 15 });
    });
  }

  test("parses a partial new shape", () => {
    const result = SessionInfo.parse({ ...base, id: "session-3", title: "Partial Session", agent: { id: "agent-2" }, messageCount: 3 });
    expect(result).toMatchObject({ agent: { id: "agent-2" }, messageCount: 3, spawnDepth: 0 });
    expect(result.agent?.name).toBeUndefined();
    for (const field of ["tokens", "summary", "projectId", "parentSessionId", "workerMeta"] as const) expect(result[field]).toBeUndefined();
  });

  for (const [name, malformed] of [
    ["agent", { agent: { id: 123 } }],
    ["tokens", { tokens: { input: "100", output: 50, total: 150 } }],
  ] as const) {
    test(`rejects malformed ${name}`, () => {
      expect(SessionInfo.safeParse({ ...base, id: `invalid-${name}`, title: "Invalid", ...malformed }).success).toBe(false);
    });
  }
});
