import { describe, expect, test } from "bun:test";
import { McpConfig, McpServerConfig, Mcp } from "../src/index.js";

describe("McpConfig.ServerConfig", () => {
  test("parses stdio server config", () => {
    const config = McpConfig.ServerConfig.parse({
      name: "filesystem",
      transport: "stdio",
      command: "mcp-server-filesystem",
      args: ["/tmp"],
      timeout: 30_000,
      retries: 2,
    });

    expect(config.name).toBe("filesystem");
    expect(config.transport).toBe("stdio");
    expect(config.args).toEqual(["/tmp"]);
  });

  test("parses http-style server config with headers", () => {
    const config = McpServerConfig.parse({
      name: "remote",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      headers: { authorization: "Bearer token" },
    });

    expect(config.transport).toBe("streamable-http");
    expect(config.headers).toEqual({ authorization: "Bearer token" });
  });

  test("rejects unknown transport", () => {
    expect(() =>
      McpConfig.ServerConfig.parse({
        name: "bad",
        transport: "websocket",
      }),
    ).toThrow();
  });
});

describe("Mcp.ToolCompleted event", () => {
  test("parses valid tool completed event", () => {
    const event = Mcp.ToolCompleted.schema.parse({
      traceId: "trace-123",
      serverName: "filesystem",
      toolName: "read_file",
      toolCallId: "call-456",
      durationMs: 150,
      resultSummary: "success:text:1024b",
      time: Date.now(),
    });

    expect(event.toolName).toBe("read_file");
    expect(event.durationMs).toBe(150);
    expect(event.resultSummary).toBe("success:text:1024b");
  });

  test("includes durationMs in payload", () => {
    const now = Date.now();
    const event = Mcp.ToolCompleted.schema.parse({
      traceId: "trace-789",
      serverName: "web",
      toolName: "fetch",
      toolCallId: "call-999",
      durationMs: 500,
      resultSummary: "success:text:2048b",
      time: now,
    });

    expect(event.durationMs).toBeGreaterThan(0);
  });

  test("includes resultSummary without raw output", () => {
    const event = Mcp.ToolCompleted.schema.parse({
      traceId: "trace-abc",
      serverName: "api",
      toolName: "query",
      toolCallId: "call-def",
      durationMs: 200,
      resultSummary: "success:json:5000b",
      time: Date.now(),
    });

    expect(event.resultSummary).toContain("success");
    expect(event.resultSummary).toContain("json");
    expect(event.resultSummary).toContain("5000b");
  });

  test("rejects missing durationMs", () => {
    expect(() =>
      Mcp.ToolCompleted.schema.parse({
        traceId: "trace-123",
        serverName: "filesystem",
        toolName: "read_file",
        toolCallId: "call-456",
        resultSummary: "success:text:1024b",
        time: Date.now(),
      }),
    ).toThrow();
  });

  test("rejects missing resultSummary", () => {
    expect(() =>
      Mcp.ToolCompleted.schema.parse({
        traceId: "trace-123",
        serverName: "filesystem",
        toolName: "read_file",
        toolCallId: "call-456",
        durationMs: 150,
        time: Date.now(),
      }),
    ).toThrow();
  });
});
