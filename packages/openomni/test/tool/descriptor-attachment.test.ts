import { describe, expect, it, mock } from "bun:test";
import { RuntimeResource, type Tool, type WorkerBootstrap } from "@openomni/protocol";
import { defineTool } from "../../src/execution-runtime/tool/define.js";
import { ToolRuntimePolicyMiddleware } from "../../src/execution-runtime/tool/middleware/tool-runtime-policy.js";
import { ToolProxyProvider } from "../../src/execution-runtime/tool/tool-proxy-provider.js";

const inputSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

function makeResult(call: Tool.Call): Tool.Result {
  return { id: "result", toolCallId: call.id, output: "ok" };
}

describe("native tool runtime descriptors", () => {
  it("attaches a system RuntimeResource.Descriptor from tool metadata", () => {
    const tool = defineTool<{ path: string }>({
      name: "read",
      inputSchema,
      riskTier: 0,
      isReadOnly: true,
      labels: ["domain:filesystem"],
      async execute(call) {
        return makeResult(call);
      },
    });

    const descriptor = tool.descriptor;
    if (descriptor === undefined) throw new Error("expected descriptor");

    expect(descriptor).toEqual({
      id: "tool:system:read",
      kind: "tool",
      source: { type: "system" },
      labels: ["tool:read", "risk:tier-0", "source:system", "capability:read", "domain:filesystem"],
      capabilities: ["read"],
      effects: [],
      risk: 0,
    });
    expect(RuntimeResource.Descriptor.parse(descriptor)).toEqual(descriptor);
  });

  it("attaches a server RuntimeResource.Descriptor for server-origin tools", () => {
    const tool = defineTool<{ path: string }>({
      name: "custom.write",
      source: "server",
      inputSchema,
      riskTier: 2,
      isReadOnly: false,
      isDestructive: true,
      labels: ["domain:custom"],
      async execute(call) {
        return makeResult(call);
      },
    });

    const descriptor = tool.descriptor;
    if (descriptor === undefined) throw new Error("expected descriptor");

    expect(descriptor).toMatchObject({
      id: "tool:server:custom.write",
      kind: "tool",
      source: { type: "server" },
      labels: tool.labels,
      capabilities: ["write"],
      effects: ["destructive"],
      risk: 2,
    });
    expect(RuntimeResource.Descriptor.safeParse(descriptor).success).toBe(true);
  });

  it("preserves descriptors when proxying worker tools", () => {
    const descriptor: RuntimeResource.Descriptor = {
      id: "tool:server:remote.echo",
      kind: "tool",
      source: { type: "server" },
      labels: ["tool:remote.echo", "risk:tier-1"],
      capabilities: ["write"],
      effects: [],
      risk: 1,
    };
    const entry: WorkerBootstrap.RuntimeToolCatalogEntry = {
      canonicalName: "remote.echo",
      exposedName: "remote_echo",
      source: "server",
      category: "custom",
      riskTier: 1,
      spec: { name: "remote.echo", inputSchema, labels: descriptor.labels },
      descriptor,
    };
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "ok" }));

    const provider = ToolProxyProvider.create([entry], callTool);
    const [tool] = provider.listTools();

    expect(tool?.descriptor).toBe(descriptor);
  });

  it("resolves runtime policy risk from descriptor before legacy riskTier", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      toolName: "bash",
      input: {},
      riskTier: 0,
      descriptor: {
        id: "tool:system:bash",
        kind: "tool",
        source: { type: "system" },
        labels: ["risk:tier-2"],
        capabilities: ["write"],
        effects: [],
        risk: 2,
      },
      timeoutConfig: { tier0: 10, tier2: 123 },
      lockOwnerId: "owner",
    });

    expect(result.handle.timeoutMs).toBe(123);
  });
});
