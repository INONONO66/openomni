import { describe, expect, it } from "bun:test";
import type { Tool as ProtocolTool } from "@openomni/protocol";
import {
  defineTool,
  errorResult,
  fromError,
  optionalBoolean,
  optionalPositiveInteger,
  optionalPositiveNumber,
  optionalString,
  requireString,
  resolveMeta,
  successResult,
} from "./define.js";

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

describe("requireString", () => {
  it("returns value when key is a non-empty string", () => {
    expect(requireString({ name: "alice" }, "name")).toBe("alice");
  });

  it("throws when key is missing", () => {
    expect(() => requireString({}, "name")).toThrow("name must be a non-empty string");
  });

  it("throws when value is an empty string", () => {
    expect(() => requireString({ name: "" }, "name")).toThrow("name must be a non-empty string");
  });

  it("throws when value is not a string", () => {
    expect(() => requireString({ count: 42 }, "count")).toThrow("count must be a non-empty string");
    expect(() => requireString({ flag: true }, "flag")).toThrow("flag must be a non-empty string");
    expect(() => requireString({ obj: {} }, "obj")).toThrow("obj must be a non-empty string");
  });

  it("throws when value is null", () => {
    expect(() => requireString({ name: null }, "name")).toThrow("name must be a non-empty string");
  });
});

describe("optionalString", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalString({}, "name")).toBeUndefined();
  });

  it("returns the string when present and non-empty", () => {
    expect(optionalString({ name: "bob" }, "name")).toBe("bob");
  });

  it("throws when value is present but empty", () => {
    expect(() => optionalString({ name: "" }, "name")).toThrow("name must be a non-empty string");
  });

  it("throws when value is present but not a string", () => {
    expect(() => optionalString({ name: 123 }, "name")).toThrow("name must be a non-empty string");
  });
});

describe("optionalBoolean", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalBoolean({}, "flag")).toBeUndefined();
  });

  it("returns true when value is true", () => {
    expect(optionalBoolean({ flag: true }, "flag")).toBe(true);
  });

  it("returns false when value is false", () => {
    expect(optionalBoolean({ flag: false }, "flag")).toBe(false);
  });

  it("throws when value is a string", () => {
    expect(() => optionalBoolean({ flag: "true" }, "flag")).toThrow("flag must be a boolean");
  });

  it("throws when value is a number", () => {
    expect(() => optionalBoolean({ flag: 1 }, "flag")).toThrow("flag must be a boolean");
  });
});

describe("optionalPositiveInteger", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalPositiveInteger({}, "limit")).toBeUndefined();
  });

  it("returns value for a positive integer", () => {
    expect(optionalPositiveInteger({ limit: 5 }, "limit")).toBe(5);
    expect(optionalPositiveInteger({ limit: 1 }, "limit")).toBe(1);
  });

  it("throws for zero", () => {
    expect(() => optionalPositiveInteger({ limit: 0 }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });

  it("throws for negative integer", () => {
    expect(() => optionalPositiveInteger({ limit: -3 }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });

  it("throws for non-integer number", () => {
    expect(() => optionalPositiveInteger({ limit: 1.5 }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });

  it("throws for string value", () => {
    expect(() => optionalPositiveInteger({ limit: "5" }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });
});

describe("optionalPositiveNumber", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalPositiveNumber({}, "temperature")).toBeUndefined();
  });

  it("returns value for a positive number", () => {
    expect(optionalPositiveNumber({ temperature: 0.7 }, "temperature")).toBe(0.7);
    expect(optionalPositiveNumber({ temperature: 1 }, "temperature")).toBe(1);
  });

  it("accepts non-integer positive numbers", () => {
    expect(optionalPositiveNumber({ temperature: 2.5 }, "temperature")).toBe(2.5);
  });

  it("throws for zero", () => {
    expect(() => optionalPositiveNumber({ temperature: 0 }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for negative number", () => {
    expect(() => optionalPositiveNumber({ temperature: -0.1 }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for Infinity", () => {
    expect(() => optionalPositiveNumber({ temperature: Infinity }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for NaN", () => {
    expect(() => optionalPositiveNumber({ temperature: NaN }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for string value", () => {
    expect(() => optionalPositiveNumber({ temperature: "0.7" }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });
});

const resultCall: ProtocolTool.Call = { id: "call-abc", tool: "test-tool", input: {} };

describe("successResult", () => {
  it("sets toolCallId from the call id", () => {
    const result = successResult(resultCall, "output text");
    expect(result.toolCallId).toBe("call-abc");
  });

  it("sets the output string", () => {
    const result = successResult(resultCall, "hello world");
    expect(result.output).toBe("hello world");
  });

  it("does not set isError", () => {
    const result = successResult(resultCall, "ok");
    expect(result.isError).toBeUndefined();
  });

  it("generates a unique id each call", () => {
    const a = successResult(resultCall, "ok");
    const b = successResult(resultCall, "ok");
    expect(a.id).not.toBe(b.id);
  });

  it("id is a valid UUID", () => {
    const result = successResult(resultCall, "ok");
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("errorResult", () => {
  it("sets toolCallId from the call id", () => {
    const result = errorResult(resultCall, "something failed");
    expect(result.toolCallId).toBe("call-abc");
  });

  it("sets the output string", () => {
    const result = errorResult(resultCall, "something failed");
    expect(result.output).toBe("something failed");
  });

  it("sets isError to true", () => {
    const result = errorResult(resultCall, "err");
    expect(result.isError).toBe(true);
  });

  it("generates a unique id each call", () => {
    const a = errorResult(resultCall, "err");
    const b = errorResult(resultCall, "err");
    expect(a.id).not.toBe(b.id);
  });
});

describe("fromError", () => {
  it("extracts message from an Error instance", () => {
    const result = fromError(resultCall, new Error("disk full"));
    expect(result.output).toBe("disk full");
    expect(result.isError).toBe(true);
  });

  it("converts non-Error to string", () => {
    const result = fromError(resultCall, "raw string error");
    expect(result.output).toBe("raw string error");
    expect(result.isError).toBe(true);
  });

  it("converts number to string", () => {
    const result = fromError(resultCall, 42);
    expect(result.output).toBe("42");
  });

  it("converts null to string", () => {
    const result = fromError(resultCall, null);
    expect(result.output).toBe("null");
  });

  it("converts undefined to string", () => {
    const result = fromError(resultCall, undefined);
    expect(result.output).toBe("undefined");
  });

  it("propagates toolCallId correctly", () => {
    const otherCall: ProtocolTool.Call = { id: "call-xyz", tool: "other", input: {} };
    const result = fromError(otherCall, new Error("oops"));
    expect(result.toolCallId).toBe("call-xyz");
  });
});
