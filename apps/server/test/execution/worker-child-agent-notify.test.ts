import { describe, expect, it } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import { InjectionQueue } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import type { WorkerRunState } from "../../src/execution/worker-run-state";
import { WorkerRunner } from "../../src/execution/worker-runner";

type SpawnRunOptions = Parameters<typeof WorkerRunner.spawnRun>[0];
type WorkerRunnerEnvironment = Omit<SpawnRunOptions, "params" | "respond">;

const successfulResult: AgentResult = {
  text: "done",
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  finishReason: "stop",
};

function createSpawnOptions(
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
  overrides: Partial<WorkerRunnerEnvironment> = {},
): SpawnRunOptions {
  return {
    params,
    ipcAuthToken: "token",
    workerId: "worker-1",
    server: {
      async call() {
        throw new Error("unexpected server call");
      },
      notify() {
        return undefined;
      },
    },
    activeRuns: new Map() as WorkerRunState.ActiveRunRegistry,
    bootstrapReady: Promise.resolve(),
    injectionQueue: InjectionQueue.create(),
    defaultWorkspaceRoot: undefined,
    getBootstrap: () => null,
    resolveAuth: () => undefined,
    respond,
    ...overrides,
  };
}

function createValidRequest(): Record<string, unknown> {
  return {
    authToken: "token",
    runId: "run-1",
    sessionId: "session-1",
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "test" },
    tools: [{ name: "child_agent", inputSchema: {} }],
  };
}

describe("WorkerRunner child agent completion notification", () => {
  it("queues child completion into the parent run injection queue", async () => {
    const responses: unknown[] = [];
    const injectedResponses: InjectionQueue.PendingResponse[] = [];
    const injectionQueue = InjectionQueue.create();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          injectionQueue,
          createAgent: (config) => ({
            async run() {
              const childAgentTool = config.tools?.find((tool) => tool.name === "child_agent");
              if (!childAgentTool) return successfulResult;
              const variants = childAgentTool.inputSchema.oneOf;
              if (!Array.isArray(variants)) throw new Error("child_agent schema missing variants");

              expect(variants).toContainEqual(
                expect.objectContaining({
                  properties: expect.objectContaining({
                    action: { const: "spawn" },
                    notifyOnComplete: { type: "boolean" },
                  }),
                }),
              );
              if (!config.toolExecutor) throw new Error("tool executor missing");
              const spawn = await config.toolExecutor({
                id: "spawn-child",
                tool: "child_agent",
                input: {
                  action: "spawn",
                  prompt: "background check",
                  notifyOnComplete: true,
                },
              } satisfies Tool.Call);
              const childId = JSON.parse(spawn.output).childId;
              await config.toolExecutor({
                id: "await-child",
                tool: "child_agent",
                input: { action: "await", ids: [childId] },
              } satisfies Tool.Call);
              injectedResponses.push(...injectionQueue.drain("run-1"));
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(injectedResponses).toEqual([
      expect.objectContaining({
        output: expect.stringContaining("done"),
        injectToHistory: true,
      }),
    ]);
  });
});
