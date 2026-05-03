import { describe, expect, test } from "bun:test";
import { McpConfig, McpServerConfig } from "../src/index.js";

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
