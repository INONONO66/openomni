import { describe, expect, it } from "bun:test";

import { McpToolProvider } from "../../../src/tool/mcp";
import {
  collectBusEvents,
  createLedgerSession,
  installStorageFixture,
  makeClient,
} from "./provider-test-fixture";

installStorageFixture();

describe("McpToolProvider", () => {
  it("publishes connect lifecycle events when an audit session is provided", async () => {
    const session = createLedgerSession();
    const client = makeClient();
    const provider = new McpToolProvider({ createClient: () => client.client });
    const { events, stop } = collectBusEvents();

    try {
      await provider.addServer(
        {
          name: "search",
          transport: "stdio",
          command: "search-mcp",
          args: ["--stdio"],
          headers: { Authorization: "redacted" },
        },
        { audit: { sessionId: session.id }, actor: { operator: "test" } },
      );

      expect(client.connect).toHaveBeenCalled();
      const lifecycleEvents = events.filter(
        (event) =>
          event.name === "policy.action.requested" || event.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((event) => event.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
      ]);
      expect(lifecycleEvents[0].payload).toMatchObject({
        action: "mcp.server.connect",
        resource: "search",
        actor: { kind: "mcp_provider", sessionId: session.id, operator: "test" },
        context: {
          serverName: "search",
          transport: "stdio",
          command: "search-mcp",
          argsCount: 1,
          headerNames: ["Authorization"],
        },
      });
      expect(lifecycleEvents[1].payload).toMatchObject({
        action: "mcp.server.connect",
        resource: "search",
        verdict: "allow",
        reason: "MCP server connected",
      });
      expect(lifecycleEvents[0].payload.actionId).toBe(lifecycleEvents[1].payload.actionId);
    } finally {
      stop();
    }
  });

  it("publishes remove lifecycle events when an audit session is provided", async () => {
    const session = createLedgerSession();
    const client = makeClient();
    const provider = new McpToolProvider({ createClient: () => client.client });
    await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
    const { events, stop } = collectBusEvents();

    try {
      await provider.removeServer("search", { audit: { sessionId: session.id } });

      expect(client.disconnect).toHaveBeenCalled();
      expect(provider.serverCount).toBe(0);
      const lifecycleEvents = events.filter(
        (event) =>
          event.name === "policy.action.requested" || event.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((event) => event.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
      ]);
      expect(lifecycleEvents[0].payload).toMatchObject({
        action: "mcp.server.disconnect",
        resource: "search",
        context: { serverName: "search" },
      });
      expect(lifecycleEvents[1].payload).toMatchObject({
        action: "mcp.server.disconnect",
        resource: "search",
        verdict: "allow",
      });
      expect(lifecycleEvents[0].payload.actionId).toBe(lifecycleEvents[1].payload.actionId);
    } finally {
      stop();
    }
  });

  it("publishes disconnectAll lifecycle events when an audit session is provided", async () => {
    const session = createLedgerSession();
    const searchClient = makeClient();
    const memoryClient = makeClient();
    const clients = new Map([
      ["search", searchClient.client],
      ["memory", memoryClient.client],
    ]);
    const provider = new McpToolProvider({
      createClient: (config) => {
        const client = clients.get(config.name);
        if (!client) throw new Error(`missing client for ${config.name}`);
        return client;
      },
    });
    await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
    await provider.addServer({ name: "memory", transport: "stdio", command: "memory-mcp" });
    const { events, stop } = collectBusEvents();

    try {
      await provider.disconnectAll({ audit: { sessionId: session.id } });

      expect(searchClient.disconnect).toHaveBeenCalled();
      expect(memoryClient.disconnect).toHaveBeenCalled();
      expect(provider.serverCount).toBe(0);
      const lifecycleEvents = events.filter(
        (event) =>
          event.name === "policy.action.requested" || event.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((event) => event.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
      ]);
      expect(lifecycleEvents[0].payload).toMatchObject({
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        context: { serverNames: ["search", "memory"] },
      });
      expect(lifecycleEvents[1].payload).toMatchObject({
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        verdict: "allow",
      });
      expect(lifecycleEvents[0].payload.actionId).toBe(lifecycleEvents[1].payload.actionId);
    } finally {
      stop();
    }
  });

  it("omits lifecycle audit events when no audit session is provided", async () => {
    const client = makeClient();
    const provider = new McpToolProvider({ createClient: () => client.client });
    const { events, stop } = collectBusEvents();

    try {
      await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
      await provider.removeServer("search");

      expect(client.connect).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
      const lifecycleEvents = events.filter(
        (event) =>
          event.name === "policy.action.requested" || event.name === "policy.action.approved",
      );
      expect(lifecycleEvents).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
