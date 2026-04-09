import { describe, it, expect } from "bun:test";
import { createToolExecutor } from "../src/tool/executor";
import type { NativeTool, ToolRiskTier } from "../src/tool/types";
import type { Tool } from "@openomni/protocol";

function createMockTool(name: string, riskTier: ToolRiskTier, output: string): NativeTool {
  return {
    spec: {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: "object", properties: {} },
    },
    prompt: `Use ${name}`,
    riskTier,
    isReadOnly: riskTier === 0,
    isDestructive: false,
    isConcurrencySafe: riskTier === 0,
    source: "system",
    execute: (call) => Promise.resolve({ id: crypto.randomUUID(), toolCallId: call.id, output }),
  };
}

function makeCall(tool: string): Tool.Call {
  return { id: crypto.randomUUID(), tool, input: {} };
}

describe("createToolExecutor", () => {
  it("dispatches to correct tool and returns output", async () => {
    const tool = createMockTool("read", 0, "file contents");
    const executor = createToolExecutor({ tools: [tool] });

    const result = await executor(makeCall("read"));

    expect(result.output).toBe("file contents");
    expect(result.isError).toBeFalsy();
  });

  it("returns error for unknown tool", async () => {
    const executor = createToolExecutor({ tools: [] });

    const result = await executor(makeCall("unknown.tool"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool");
  });

  it("dispatches across multiple tools", async () => {
    const readTool = createMockTool("read", 0, "read output");
    const globTool = createMockTool("glob", 0, "glob output");
    const executor = createToolExecutor({ tools: [readTool, globTool] });

    const readResult = await executor(makeCall("read"));
    const globResult = await executor(makeCall("glob"));

    expect(readResult.output).toBe("read output");
    expect(globResult.output).toBe("glob output");
  });

  it("blocks tool on denylist", async () => {
    const tool = createMockTool("bash", 2, "output");
    const executor = createToolExecutor({
      tools: [tool],
      config: { permissions: { denylist: ["bash"] } },
    });

    const result = await executor(makeCall("bash"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("denied");
  });

  it("blocks tools not on allowlist", async () => {
    const readTool = createMockTool("read", 0, "ok");
    const writeTool = createMockTool("write", 1, "ok");
    const executor = createToolExecutor({
      tools: [readTool, writeTool],
      config: { permissions: { allowlist: ["read"] } },
    });

    const allowed = await executor(makeCall("read"));
    const blocked = await executor(makeCall("write"));

    expect(allowed.isError).toBeFalsy();
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("denied");
  });

  it("matches wildcard patterns on denylist", async () => {
    const grepTool = createMockTool("grep.search", 0, "grep");
    const grepReplace = createMockTool("grep.replace", 1, "replace");
    const readTool = createMockTool("read", 0, "file");
    const executor = createToolExecutor({
      tools: [grepTool, grepReplace, readTool],
      config: { permissions: { denylist: ["grep.*"] } },
    });

    expect((await executor(makeCall("grep.search"))).isError).toBe(true);
    expect((await executor(makeCall("grep.replace"))).isError).toBe(true);
    expect((await executor(makeCall("read"))).isError).toBeFalsy();
  });

  it("wildcard allowlist permits matching tools only", async () => {
    const grepSearch = createMockTool("grep.search", 0, "ok");
    const grepReplace = createMockTool("grep.replace", 1, "ok");
    const bashExec = createMockTool("bash", 2, "nope");
    const executor = createToolExecutor({
      tools: [grepSearch, grepReplace, bashExec],
      config: { permissions: { allowlist: ["grep.*"] } },
    });

    expect((await executor(makeCall("grep.search"))).isError).toBeFalsy();
    expect((await executor(makeCall("grep.replace"))).isError).toBeFalsy();
    expect((await executor(makeCall("bash"))).isError).toBe(true);
  });

  it("denylist takes priority over allowlist", async () => {
    const tool = createMockTool("write", 1, "ok");
    const executor = createToolExecutor({
      tools: [tool],
      config: { permissions: { allowlist: ["write"], denylist: ["write"] } },
    });

    const result = await executor(makeCall("write"));

    expect(result.isError).toBe(true);
  });

  it("blocks tool requiring approval", async () => {
    const tool = createMockTool("bash", 2, "output");
    const executor = createToolExecutor({
      tools: [tool],
      config: { permissions: { requireApproval: ["bash"] } },
    });

    const result = await executor(makeCall("bash"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("requires approval");
  });

  it("returns error when tool execution throws", async () => {
    const failTool: NativeTool = {
      spec: { name: "fail", inputSchema: { type: "object" } },
      prompt: "Use fail",
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      source: "system",
      execute: () => Promise.reject(new Error("boom")),
    };
    const executor = createToolExecutor({ tools: [failTool] });

    const result = await executor(makeCall("fail"));

    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("times out slow tool execution", async () => {
    const slowTool: NativeTool = {
      spec: { name: "slow", inputSchema: { type: "object" } },
      prompt: "Use slow",
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "system",
      execute: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    };
    const executor = createToolExecutor({
      tools: [slowTool],
      config: { timeoutMs: { tier0: 50 } },
    });

    const result = await executor(makeCall("slow"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("timeout");
  });
});
