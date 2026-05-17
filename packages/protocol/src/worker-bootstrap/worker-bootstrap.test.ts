import { describe, expect, test } from "bun:test";
import { WorkerBootstrap } from "./index.js";

describe("WorkerBootstrap", () => {
  test("RuntimeAgentDefinition round-trip parse", () => {
    const agent = {
      name: "test-agent",
      description: "A test agent",
      tools: { allow: ["tool1", "tool2"] },
      model: { provider: "anthropic", id: "claude-3-sonnet" },
      systemPrompt: "You are helpful",
    };

    const parsed = WorkerBootstrap.RuntimeAgentDefinition.parse(agent);
    expect(parsed.name).toBe("test-agent");
    expect(parsed.tools).toEqual({ allow: ["tool1", "tool2"] });
  });

  test("RuntimeToolCatalogEntry round-trip parse", () => {
    const entry = {
      canonicalName: "fs.read",
      exposedName: "read_file",
      source: "system" as const,
      category: "filesystem" as const,
      riskTier: 2 as const,
      spec: {
        name: "read_file",
        description: "Read a file",
        inputSchema: { path: { type: "string" } },
      },
    };

    const parsed = WorkerBootstrap.RuntimeToolCatalogEntry.parse(entry);
    expect(parsed.canonicalName).toBe("fs.read");
    expect(parsed.source).toBe("system");
    expect(parsed.category).toBe("filesystem");
    expect(parsed.riskTier).toEqual(2);
  });

  test("RuntimeToolCatalogEntry rejects non-canonical source and risk tier", () => {
    expect(
      WorkerBootstrap.RuntimeToolCatalogEntry.safeParse({
        canonicalName: "fs.read",
        exposedName: "read_file",
        source: "custom",
        category: "filesystem",
        riskTier: 0,
        spec: {
          name: "read_file",
          inputSchema: {},
        },
      }).success,
    ).toBe(false);

    expect(
      WorkerBootstrap.RuntimeToolCatalogEntry.safeParse({
        canonicalName: "fs.read",
        exposedName: "read_file",
        source: "system",
        category: "filesystem",
        riskTier: 4,
        spec: {
          name: "read_file",
          inputSchema: {},
        },
      }).success,
    ).toBe(false);
  });

  test("WorkerSnapshot round-trip parse", () => {
    const snapshot = {
      activeRuns: ["run1", "run2"],
      backgroundTasks: [{ id: "task1", status: "running" }],
      lastHeartbeat: Date.now(),
      memoryRss: 512000000,
      configEpoch: "v1.0.0",
    };

    const parsed = WorkerBootstrap.WorkerSnapshot.parse(snapshot);
    expect(parsed.activeRuns).toEqual(["run1", "run2"]);
    expect(parsed.backgroundTasks).toHaveLength(1);
    expect(parsed.configEpoch).toBe("v1.0.0");
  });

  test("Bootstrap round-trip parse", () => {
    const bootstrap = {
      configEpoch: "v1.0.0",
      agents: [
        {
          name: "agent1",
          description: "First agent",
          tools: { allow: ["tool1"] },
        },
      ],
      toolCatalog: [
        {
          canonicalName: "mcp.tool1",
          exposedName: "tool1",
          source: "mcp" as const,
          category: "mcp" as const,
          riskTier: 1 as const,
          spec: {
            name: "tool1",
            inputSchema: {},
          },
          mcpServer: "localhost:3000",
        },
      ],
      credentials: { API_KEY: "secret" },
    };

    const parsed = WorkerBootstrap.Bootstrap.parse(bootstrap);
    expect(parsed.configEpoch).toBe("v1.0.0");
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.toolCatalog).toHaveLength(1);
    expect(parsed.credentials?.API_KEY).toBe("secret");
  });

  test("Bootstrap with optional fields", () => {
    const bootstrap = {
      configEpoch: "v1.0.0",
      agents: [],
      toolCatalog: [],
    };

    const parsed = WorkerBootstrap.Bootstrap.parse(bootstrap);
    expect(parsed.credentials).toBeUndefined();
  });
});
