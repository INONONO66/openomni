import { describe, expect, it } from "bun:test";
import {
  convertMcpTool,
  convertMcpResult,
} from "../../../src/runtime/mcp/convert";

describe("convertMcpTool", () => {
  it("converts basic MCP tool to Tool.Spec", () => {
    const mcpTool = {
      name: "read_file",
      description: "Reads a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };

    const spec = convertMcpTool(mcpTool);
    expect(spec.name).toBe("read_file");
    expect(spec.description).toBe("Reads a file");
    expect(spec.inputSchema).toEqual(mcpTool.inputSchema);
  });

  it("namespaces tool name with server name", () => {
    const spec = convertMcpTool(
      { name: "read", description: "Read" },
      "fs-server",
    );
    expect(spec.name).toBe("fs-server.read");
  });

  it("uses empty schema when inputSchema is missing", () => {
    const spec = convertMcpTool({ name: "ping" });
    expect(spec.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("preserves undefined description", () => {
    const spec = convertMcpTool({ name: "tool" });
    expect(spec.description).toBeUndefined();
  });
});

describe("convertMcpResult", () => {
  it("converts text content to Tool.Result", () => {
    const mcpResult = {
      content: [{ type: "text", text: "hello world" }],
    };

    const result = convertMcpResult(mcpResult, "call-123");
    expect(result.toolCallId).toBe("call-123");
    expect(result.output).toBe("hello world");
    expect(result.isError).toBe(false);
  });

  it("joins multiple text parts", () => {
    const mcpResult = {
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    };

    const result = convertMcpResult(mcpResult, "call-456");
    expect(result.output).toBe("part1\npart2");
  });

  it("marks error results", () => {
    const mcpResult = {
      content: [{ type: "text", text: "error occurred" }],
      isError: true,
    };

    const result = convertMcpResult(mcpResult, "call-789");
    expect(result.isError).toBe(true);
  });

  it("ignores non-text content types", () => {
    const mcpResult = {
      content: [
        { type: "image", text: "ignored" },
        { type: "text", text: "kept" },
      ],
    };

    const result = convertMcpResult(mcpResult, "call-abc");
    expect(result.output).toBe("kept");
  });
});
