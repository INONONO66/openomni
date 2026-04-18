import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { createToolExecutor } from "./executor.js";
import type { NativeTool, ToolRiskTier } from "./types.js";

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: "call-1", tool, input };
}

function makeTool(
  name: string,
  overrides: Partial<NativeTool> & { riskTier?: ToolRiskTier } = {},
): NativeTool {
  const { riskTier = 0, ...rest } = overrides;
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `${name}-ok`,
    }),
    ...rest,
  };
}

describe("createToolExecutor", () => {
  it("dispatches to the correct tool and returns its result", async () => {
    const executor = createToolExecutor({
      tools: [
        makeTool("read", {
          execute: async (call) => ({ id: "r1", toolCallId: call.id, output: "file-content" }),
        }),
      ],
    });

    const result = await executor(makeCall("read"));

    expect(result.output).toBe("file-content");
    expect(result.isError).toBeUndefined();
    expect(result.toolCallId).toBe("call-1");
  });

  it("returns an error result for unknown tools", async () => {
    const executor = createToolExecutor({ tools: [] });

    const result = await executor(makeCall("nonexistent"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: nonexistent");
  });

  it("denies tools matching the denylist", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: { permissions: { denylist: ["bash"] } },
    });

    const result = await executor(makeCall("bash"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("[Blocked]");
    expect(result.output).toContain("denied by policy");
  });

  it("denies tools absent from the allowlist", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("write"), makeTool("read")],
      config: { permissions: { allowlist: ["read"] } },
    });

    const writeResult = await executor(makeCall("write"));
    expect(writeResult.isError).toBe(true);
    expect(writeResult.output).toContain("[Blocked]");

    const readResult = await executor(makeCall("read"));
    expect(readResult.isError).toBeUndefined();
  });

  it("blocks tools that require approval", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: { permissions: { requireApproval: ["bash"] } },
    });

    const result = await executor(makeCall("bash"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("requires approval");
  });

  it("wraps tool execution errors in an error result", async () => {
    const executor = createToolExecutor({
      tools: [
        makeTool("fail", {
          execute: async () => {
            throw new Error("boom");
          },
        }),
      ],
    });

    const result = await executor(makeCall("fail"));

    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("dispatches to a dotted-name tool via its underscore alias", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("grep.search")],
    });

    const result = await executor(makeCall("grep_search"));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("grep.search-ok");
  });

  it("denylist wildcard pattern blocks the entire tool family", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("file.read"), makeTool("file.write"), makeTool("bash")],
      config: { permissions: { denylist: ["file.*"] } },
    });

    const readResult = await executor(makeCall("file.read"));
    expect(readResult.isError).toBe(true);

    const writeResult = await executor(makeCall("file.write"));
    expect(writeResult.isError).toBe(true);

    const bashResult = await executor(makeCall("bash"));
    expect(bashResult.isError).toBeUndefined();
  });

  it("no permissions config allows all tools", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash"), makeTool("read")],
    });

    expect((await executor(makeCall("bash"))).isError).toBeUndefined();
    expect((await executor(makeCall("read"))).isError).toBeUndefined();
  });
});
