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

    expect(tool.spec).toMatchObject({
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
      labels: ["tool:test.tool", "risk:tier-1", "source:system", "capability:write"],
    });
    expect(tool.riskTier).toBe(1);
    expect(tool.source).toBe("system");
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isDestructive).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);
    expect(tool.labels).toEqual([
      "tool:test.tool",
      "risk:tier-1",
      "source:system",
      "capability:write",
    ]);

    const result = await tool.execute(makeCall({ cmd: "ls" }));
    expect(result.output).toBe("ls");
  });
});

describe("defineTool with implicitInputs", () => {
  it("strips implicit fields from public schema", () => {
    const tool = defineTool<{ sessionId: string; text: string }>({
      name: "my_tool",
      implicitInputs: { sessionId: "sessionId" },
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionId", "text"],
      },
      async execute(call) {
        return { id: "1", toolCallId: call.id, output: "ok" };
      },
    });

    const schema = tool.spec.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props.sessionId).toBeUndefined();
    expect(props.text).toBeDefined();
    expect(schema.required).toEqual(["text"]);
  });

  it("preserves implicitInputs on the NativeTool", () => {
    const tool = defineTool<{ sessionId: string }>({
      name: "my_tool",
      implicitInputs: { sessionId: "sessionId" },
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      async execute(call) {
        return { id: "1", toolCallId: call.id, output: "ok" };
      },
    });

    expect(tool.implicitInputs).toEqual({ sessionId: "sessionId" });
  });

  it("does not set implicitInputs when not provided", () => {
    const tool = defineTool<{ text: string }>({
      name: "plain_tool",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async execute(call) {
        return { id: "1", toolCallId: call.id, output: "ok" };
      },
    });

    expect(tool.implicitInputs).toBeUndefined();
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
