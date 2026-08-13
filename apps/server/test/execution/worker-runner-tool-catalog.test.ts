import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";

import { WorkerRunner } from "../../src/execution/worker-runner";
import {
  createSpawnOptions,
  createValidRequest,
  successfulResult,
  toolCallContext,
} from "./worker-runner-fixture";

describe("WorkerRunner", () => {
  it("exposes dispatch without polling tools for resident guidance", async () => {
    const responses: unknown[] = [];
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          workspaceRoot: "/worker/repo",
          tools: [{ name: "dispatch", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              const toolNames = options.tools?.map((tool) => tool.name) ?? [];
              const dispatchTool = options.tools?.find((tool) => tool.name === "dispatch");
              expect(toolNames).toContain("dispatch");
              expect(dispatchTool?.inputSchema).toMatchObject({
                properties: {
                  action: { const: "resident.ask" },
                  target: {
                    properties: { kind: { const: "resident" } },
                    additionalProperties: false,
                  },
                  wait: { const: true },
                },
                required: ["action", "target", "wait"],
              });
              expect(
                (dispatchTool?.inputSchema as { properties?: Record<string, unknown> }).properties
                  ?.target,
              ).not.toHaveProperty("properties.sessionId");
              expect(toolNames).not.toContain("check_inbox");
              expect(toolNames).not.toContain("ask_main");
              expect(options.systemPrompt).toContain(
                "dispatch action resident.ask with wait: true",
              );
              expect(options.systemPrompt).toContain(
                "responses from other agents arrive automatically, no polling needed",
              );
              expect(options.systemPrompt).not.toContain("use ask_main");
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });

  it("does not expose subagent as a worker delegation tool", async () => {
    const responses: unknown[] = [];
    let subagentResult: Tool.Result | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "dispatch", inputSchema: {} }],
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: { permission: { action: "tool.call", allowlist: ["dispatch"] } },
              },
            ],
            labels: ["security"],
          },
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              subagentResult = await options.toolExecutor(
                {
                  id: "agent-tool-call",
                  tool: "subagent",
                  input: { agentName: "child", prompt: "delegate" },
                },
                toolCallContext(),
              );
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(subagentResult).toMatchObject({
      id: expect.any(String),
      toolCallId: expect.any(String),
      isError: true,
      output: "Unknown tool: subagent",
    });
  });
});
