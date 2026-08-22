import { describe, expect, it } from "bun:test";
import { convertMcpResult, convertMcpTool } from "../../../src/runtime/mcp/convert";

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

  it.each([
    [
      "namespaces tool name with server name",
      { name: "read", description: "Read" },
      "fs-server",
      "name",
      "fs-server.read",
    ],
    [
      "uses empty schema when inputSchema is missing",
      { name: "ping" },
      undefined,
      "inputSchema",
      { type: "object", properties: {} },
    ],
    ["preserves undefined description", { name: "tool" }, undefined, "description", undefined],
  ] as const)("%s", (_name, tool, server, field, expected) => {
    expect(convertMcpTool(tool, server)[field]).toEqual(expected);
  });
});

describe("convertMcpResult", () => {
  it("converts text content to Tool.Result", () => {
    const result = convertMcpResult(
      { content: [{ type: "text", text: "hello world" }] },
      "call-123",
    );
    expect(result.toolCallId).toBe("call-123");
    expect(result.output).toBe("hello world");
    expect(result.isError).toBe(false);
  });

  it.each([
    [
      "joins multiple text parts",
      {
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
      "call-456",
      "output",
      "part1\npart2",
    ],
    [
      "marks error results",
      { content: [{ type: "text", text: "error occurred" }], isError: true },
      "call-789",
      "isError",
      true,
    ],
    [
      "ignores non-text content types",
      {
        content: [
          { type: "image", text: "ignored" },
          { type: "text", text: "kept" },
        ],
      },
      "call-abc",
      "output",
      "kept",
    ],
  ] as const)("%s", (_name, mcpResult, callId, field, expected) => {
    expect(convertMcpResult({ ...mcpResult, content: [...mcpResult.content] }, callId)[field]).toBe(
      expected,
    );
  });
});
