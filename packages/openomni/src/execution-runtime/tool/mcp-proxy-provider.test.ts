import { describe, expect, it, mock } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { ToolProxyProvider } from "./tool-proxy-provider.js";

function makeSpec(overrides: Partial<Tool.Spec> = {}): Tool.Spec {
  return {
    name: "filesystem.read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    safe: true,
    ...overrides,
  };
}

function makeCall(tool: string, input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool, input };
}

function getTool(
  tools: ReturnType<ReturnType<typeof ToolProxyProvider.create>["listTools"]>,
  index: number,
) {
  const tool = tools[index];
  if (tool === undefined) throw new Error(`expected tool at index ${index}`);
  return tool;
}

describe("ToolProxyProvider", () => {
  it("exposes every provisioned Tool.Spec without a bootstrap compatibility shape", () => {
    const specs: readonly [Tool.Spec, Tool.Spec] = [makeSpec({ name: "bash" }), makeSpec()];
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const tools = ToolProxyProvider.create(specs, callTool).listTools();

    expect(tools).toHaveLength(2);
    expect(getTool(tools, 0).spec).toBe(specs[0]);
    expect(getTool(tools, 1).spec).toBe(specs[1]);
  });

  it("delegates with the canonical Tool.Spec name and exact input", async () => {
    const expected: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-1",
      output: "file content",
    };
    const callTool = mock(async () => expected);
    const tool = getTool(ToolProxyProvider.create([makeSpec()], callTool).listTools(), 0);

    const result = await tool.execute(makeCall("filesystem.read_file", { path: "/tmp/test.txt" }));

    expect(callTool).toHaveBeenCalledWith("filesystem.read_file", { path: "/tmp/test.txt" });
    expect(result).toBe(expected);
  });

  it("forwards execution context to the provisioned caller", async () => {
    const controller = new AbortController();
    const expected: Tool.Result = { id: "r1", toolCallId: "c1", output: "ok" };
    const callTool = mock(async () => expected);
    const tool = getTool(ToolProxyProvider.create([makeSpec()], callTool).listTools(), 0);

    const result = await tool.execute(makeCall("filesystem.read_file", {}), {
      signal: controller.signal,
    });

    expect(result).toBe(expected);
    expect(callTool).toHaveBeenCalledWith(
      "filesystem.read_file",
      {},
      {
        signal: controller.signal,
      },
    );
  });

  it("returns an empty surface when no specs are provisioned", () => {
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));
    expect(ToolProxyProvider.create([], callTool).listTools()).toEqual([]);
  });

  it("maps explicit safe metadata and treats omitted safety as high risk", () => {
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));
    const unclassified: Tool.Spec = { name: "unclassified", inputSchema: {} };
    const tools = ToolProxyProvider.create(
      [makeSpec({ name: "safe", safe: true }), unclassified],
      callTool,
    ).listTools();

    expect(getTool(tools, 0).riskTier).toBe(0);
    expect(getTool(tools, 0).isReadOnly).toBe(true);
    expect(getTool(tools, 1).riskTier).toBe(2);
    expect(getTool(tools, 1).isReadOnly).toBe(false);
    expect(getTool(tools, 1).isDestructive).toBe(false);
    expect(getTool(tools, 1).isConcurrencySafe).toBe(false);
  });

  it("preserves labels from the strict provisioned spec", () => {
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));
    const tool = getTool(
      ToolProxyProvider.create(
        [makeSpec({ labels: ["filesystem", "read"] })],
        callTool,
      ).listTools(),
      0,
    );

    expect(tool.labels).toEqual(["filesystem", "read"]);
  });
});
