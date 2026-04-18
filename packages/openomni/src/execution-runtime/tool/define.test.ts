import { describe, expect, it } from "bun:test";
import type { Tool as ProtocolTool } from "@openomni/protocol";
import { defineTool, resolveMeta } from "./define.js";

function makeCall(input: Record<string, unknown>): ProtocolTool.Call {
  return {
    id: crypto.randomUUID(),
    tool: "test.tool",
    input,
  };
}

describe("defineTool", () => {
  it("returns a NativeTool with default metadata", async () => {
    const tool = defineTool<{ cmd: string }>({
      name: "test.tool",
      description: "Test tool",
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string" },
        },
        required: ["cmd"],
      },
      async execute(call) {
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: String(call.input.cmd),
        };
      },
    });

    expect(tool.spec).toEqual({
      name: "test.tool",
      description: "Test tool",
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string" },
        },
        required: ["cmd"],
      },
      safe: false,
    });
    expect(tool.riskTier).toBe(1);
    expect(tool.source).toBe("system");
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isDestructive).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);

    const result = await tool.execute(makeCall({ cmd: "ls" }));
    expect(result.output).toBe("ls");
  });
});

describe("resolveMeta", () => {
  it("returns true for static true", () => {
    expect(resolveMeta(true, { cmd: "ls" })).toBe(true);
  });

  it("returns false for static false", () => {
    expect(resolveMeta(false, { cmd: "ls" })).toBe(false);
  });

  it("evaluates function metadata to true", () => {
    expect(resolveMeta((input) => (input as { cmd?: string }).cmd === "ls", { cmd: "ls" })).toBe(
      true,
    );
  });

  it("evaluates function metadata to false", () => {
    expect(resolveMeta((input) => (input as { cmd?: string }).cmd === "ls", { cmd: "rm" })).toBe(
      false,
    );
  });
});
