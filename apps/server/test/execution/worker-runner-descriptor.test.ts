import { describe, expect, it } from "bun:test";
import type { ChatAgentConfig } from "@openomni/agent";
import type { Policy, WorkerBootstrap } from "@openomni/protocol";

import { WorkerRunner } from "../../src/execution/worker-runner";
import { createSpawnOptions, createValidRequest, successfulResult } from "./worker-runner-fixture";

type AgentTool = NonNullable<ChatAgentConfig["tools"]>[number];

describe("WorkerRunner tool descriptors", () => {
  it("preserves the listed MCP descriptor and keeps the dotted name when exposing a tool to ChatAgent", async () => {
    // Given
    const descriptor: Policy.Resource.Descriptor = {
      id: "tool:mcp:filesystem:write_file",
      kind: "tool",
      source: { type: "mcp", serverId: "filesystem", remoteName: "write_file" },
      labels: ["tool:write_file", "source:mcp", "mcp.filesystem"],
      capabilities: ["workspace.write"],
      effects: ["filesystem.mutation"],
      risk: 2,
    };
    const bootstrap: WorkerBootstrap.Bootstrap = {
      configEpoch: "epoch-1",
      agents: [],
      toolCatalog: [
        {
          canonicalName: "mcp.filesystem.write_file",
          exposedName: "mcp_filesystem_write_file",
          source: "mcp",
          category: "execution",
          riskTier: 2,
          spec: {
            name: "mcp.filesystem.write_file",
            description: "Write a file",
            inputSchema: { type: "object" },
            safe: false,
            labels: descriptor.labels,
            prompt: "Use only for requested file changes.",
          },
          descriptor,
        },
      ],
    };
    let exposedTool: AgentTool | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "mcp.filesystem.write_file", inputSchema: {} }],
        },
        () => resolve(),
        {
          getBootstrap: () => bootstrap,
          createAgent: (config) => ({
            async run() {
              // The exposed spec keeps its DOTTED internal name: the worker no
              // longer underscores here — the `@openomni/llm` wire boundary
              // (#749) owns the provider-pattern coercion on the worker path.
              exposedTool = config.tools?.find((tool) => tool.name === "mcp.filesystem.write_file");
              return successfulResult;
            },
          }),
        },
      );

      // When
      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    // Then
    expect(exposedTool).toEqual({
      name: "mcp.filesystem.write_file",
      description: "Write a file",
      inputSchema: { type: "object" },
      safe: false,
      labels: descriptor.labels,
      prompt: "Use only for requested file changes.",
      descriptor,
    });
    expect(exposedTool?.descriptor).toBe(descriptor);
  });
});
