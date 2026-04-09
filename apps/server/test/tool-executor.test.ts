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
    const tool = createMockTool("test.read", 0, "file contents");
    const executor = createToolExecutor({ tools: [tool] });

    const result = await executor(makeCall("test.read"));

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
    const fsTool = createMockTool("fs.read", 0, "fs output");
    const gitTool = createMockTool("git.status", 0, "git output");
    const executor = createToolExecutor({ tools: [fsTool, gitTool] });

    const fsResult = await executor(makeCall("fs.read"));
    const gitResult = await executor(makeCall("git.status"));

    expect(fsResult.output).toBe("fs output");
    expect(gitResult.output).toBe("git output");
  });

  it("blocks tool on denylist", async () => {
    const tool = createMockTool("shell.exec", 2, "output");
    const executor = createToolExecutor({
      tools: [tool],
      config: { permissions: { denylist: ["shell.exec"] } },
    });

    const result = await executor(makeCall("shell.exec"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("denied");
  });

  it("blocks tools not on allowlist", async () => {
    const readTool = createMockTool("fs.read", 0, "ok");
    const writeTool = createMockTool("fs.write", 1, "ok");
    const executor = createToolExecutor({
      tools: [readTool, writeTool],
      config: { permissions: { allowlist: ["fs.read"] } },
    });

    const allowed = await executor(makeCall("fs.read"));
    const blocked = await executor(makeCall("fs.write"));

    expect(allowed.isError).toBeFalsy();
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("denied");
  });

  it("matches wildcard patterns on denylist", async () => {
    const gitPush = createMockTool("git.push", 2, "pushed");
    const gitStatus = createMockTool("git.status", 0, "status");
    const fsTool = createMockTool("fs.read", 0, "file");
    const executor = createToolExecutor({
      tools: [gitPush, gitStatus, fsTool],
      config: { permissions: { denylist: ["git.*"] } },
    });

    expect((await executor(makeCall("git.push"))).isError).toBe(true);
    expect((await executor(makeCall("git.status"))).isError).toBe(true);
    expect((await executor(makeCall("fs.read"))).isError).toBeFalsy();
  });

  it("wildcard allowlist permits matching tools only", async () => {
    const fsRead = createMockTool("fs.read", 0, "ok");
    const fsWrite = createMockTool("fs.write", 1, "ok");
    const shellExec = createMockTool("shell.exec", 2, "nope");
    const executor = createToolExecutor({
      tools: [fsRead, fsWrite, shellExec],
      config: { permissions: { allowlist: ["fs.*"] } },
    });

    expect((await executor(makeCall("fs.read"))).isError).toBeFalsy();
    expect((await executor(makeCall("fs.write"))).isError).toBeFalsy();
    expect((await executor(makeCall("shell.exec"))).isError).toBe(true);
  });

  it("denylist takes priority over allowlist", async () => {
    const tool = createMockTool("fs.write", 1, "ok");
    const executor = createToolExecutor({
      tools: [tool],
      config: { permissions: { allowlist: ["fs.*"], denylist: ["fs.write"] } },
    });

    const result = await executor(makeCall("fs.write"));

    expect(result.isError).toBe(true);
  });

  it("blocks tool requiring approval", async () => {
    const tool = createMockTool("shell.exec", 2, "output");
    const executor = createToolExecutor({
      tools: [tool],
      config: { permissions: { requireApproval: ["shell.exec"] } },
    });

    const result = await executor(makeCall("shell.exec"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("requires approval");
  });

  it("returns error when tool execution throws", async () => {
    const failTool: NativeTool = {
      spec: { name: "fail.tool", inputSchema: { type: "object" } },
      prompt: "Use fail.tool",
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      source: "system",
      execute: () => Promise.reject(new Error("boom")),
    };
    const executor = createToolExecutor({ tools: [failTool] });

    const result = await executor(makeCall("fail.tool"));

    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("times out slow tool execution", async () => {
    const slowTool: NativeTool = {
      spec: { name: "slow.tool", inputSchema: { type: "object" } },
      prompt: "Use slow.tool",
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

    const result = await executor(makeCall("slow.tool"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("timeout");
  });
});
