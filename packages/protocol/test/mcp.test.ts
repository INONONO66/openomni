import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { McpConfig, Mcp } from "../src/index.js";

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
    if (config.transport !== "stdio") throw new Error("shape");
    expect(config.args).toEqual(["/tmp"]);
  });

  test("parses http-style server config with headers", () => {
    const config = McpConfig.ServerConfig.parse({
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
    ).toThrow(ZodError);
  });

  test("rejects transport configs missing runtime-required fields", () => {
    expect(() =>
      McpConfig.ServerConfig.parse({
        name: "stdio-missing-command",
        transport: "stdio",
      }),
    ).toThrow(ZodError);

    expect(() =>
      McpConfig.ServerConfig.parse({
        name: "http-missing-url",
        transport: "streamable-http",
      }),
    ).toThrow(ZodError);

    expect(() =>
      McpConfig.ServerConfig.parse({
        name: "http-invalid-url",
        transport: "sse",
        url: "not a url",
      }),
    ).toThrow(ZodError);
  });

  test("rejects invalid timeout and retry numbers", () => {
    const base = {
      name: "remote",
      transport: "streamable-http" as const,
      url: "https://example.com/mcp",
    };

    for (const field of ["timeout", "retries"] as const) {
      for (const value of [-1, 0.5, Infinity, Number.NaN]) {
        expect(() => McpConfig.ServerConfig.parse({ ...base, [field]: value })).toThrow(ZodError);
      }
    }
  });
});

describe("Mcp.Events.ToolCompleted event", () => {
  test("parses valid tool completed event", () => {
    const event = Mcp.Events.ToolCompleted.schema.parse({
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
    const event = Mcp.Events.ToolCompleted.schema.parse({
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
    const event = Mcp.Events.ToolCompleted.schema.parse({
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
      Mcp.Events.ToolCompleted.schema.parse({
        traceId: "trace-123",
        serverName: "filesystem",
        toolName: "read_file",
        toolCallId: "call-456",
        resultSummary: "success:text:1024b",
        time: Date.now(),
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing resultSummary", () => {
    expect(() =>
      Mcp.Events.ToolCompleted.schema.parse({
        traceId: "trace-123",
        serverName: "filesystem",
        toolName: "read_file",
        toolCallId: "call-456",
        durationMs: 150,
        time: Date.now(),
      }),
    ).toThrow(ZodError);
  });
});
