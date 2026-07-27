import { describe, expect, test } from "bun:test";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import {
  AgentToolProvider,
  InjectionQueue,
  createWorkspaceIdentity,
  toWorkspaceRef,
} from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { createMcpProxyProvider } from "../../src/execution/worker-runner-ipc";
import { WorkerRunner } from "../../src/execution/worker-runner";

const secret = "worker/boundary+secret=canary";
const encodedSecret = encodeURIComponent(secret);

function pairedSanitizer() {
  const sanitizer = BoundarySanitizer.create();
  const registry = SecretRegistry.create(sanitizer);
  registry.register(
    CredentialSource.parseOwner({
      providerId: "test",
      credentialId: "boundary-test",
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: secret },
    }),
  );
  return { sanitizer, registry };
}

function toolCall(): Tool.Call {
  return { id: "agent-call-1", tool: "remote.echo", input: { value: "hello" } };
}

function proxyOptions(
  sanitizer: BoundarySanitizer,
  call: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
) {
  return {
    toolCatalog: [{ name: "remote.echo", inputSchema: { type: "object" } }],
    sanitizer,
    server: {
      call,
      notify() {
        return undefined;
      },
    },
    ipcAuthToken: "ipc-token",
    workerId: "worker-1",
    generation: 4,
    runId: "run-1",
    sessionId: "session-1",
  };
}

async function runWorker(options: {
  sanitizer: BoundarySanitizer;
  queue: ReturnType<typeof InjectionQueue.create>;
  run: (middleware: readonly unknown[]) => Promise<{
    text: string;
    steps: [];
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    finishReason: "stop";
  }>;
}) {
  const workspaceIdentity = createWorkspaceIdentity(process.cwd());
  const model = { provider: "test", id: "boundary-model" } as const;
  const environmentReference = {
    environmentDigest: "e".repeat(64),
  };
  const attempt = {
    version: "attempt-ref-v1" as const,
    workItemId: "work-1",
    attemptId: "attempt-1",
    attemptSeq: 1,
  };
  const agent = {
    name: "boundary-agent",
    description: "boundary test agent",
    model,
    systemPrompt: "Keep boundary data private.",
    tools: { allow: [] },
  };
  const observations: unknown[] = [];
  let resolveResponse!: (value: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    resolveResponse = resolve;
  });

  WorkerRunner.spawnRun({
    params: {
      authToken: "ipc-token",
      runId: "run-1",
      sessionId: "session-1",
      mode: "direct",
      prompt: "current prompt",
      model,
      systemPrompt: agent.systemPrompt,
      agentName: agent.name,
    },
    respond: resolveResponse,
    ipcAuthToken: "ipc-token",
    workerId: "worker-1",
    server: {
      async call(method, params) {
        if (method !== "worker.kernel_query") throw new Error(`unexpected call: ${method}`);
        const query = params?.request as { kind?: string } | undefined;
        if (query?.kind === "authenticated_attempt") {
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_attempt",
            attempt,
            events: [],
          };
        }
        return {
          version: "kernel-query-result-v1",
          kind: "authenticated_transcript",
          messages: [],
        };
      },
      notify(_method, params) {
        observations.push(params);
      },
    },
    activeRuns: new Map(),
    injectionQueue: options.queue,
    runtime: {
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 4,
      principalId: "principal-1",
      attempt,
      config: {
        configEpoch: "epoch-1",
        model,
        environment: environmentReference,
        workspace: toWorkspaceRef(workspaceIdentity),
        agents: [agent],
        toolCatalog: [],
      },
    } as never,
    workspaceIdentity,
    environment: {
      reference: environmentReference,
      sanitizer: options.sanitizer,
    } as never,
    modelCatalog: {} as never,
    createAgentToolProvider: (providerOptions) =>
      new AgentToolProvider(providerOptions as ConstructorParameters<typeof AgentToolProvider>[0]),
    createAgent: (agentOptions) => ({
      run: () => options.run(agentOptions.middleware ?? []),
    }),
  });

  return { response: await response, observations };
}

describe("worker runner IPC boundaries", () => {
  test("drains the retained WorkerRunner queue policy into a prompt injection", async () => {
    const { sanitizer, registry } = pairedSanitizer();
    const queue = InjectionQueue.create();
    queue.enqueue("run-1", {
      messageId: "injection-1",
      output: "queued worker response",
      timestamp: 1,
    });

    const result = await runWorker({
      sanitizer,
      queue,
      async run(middleware) {
        const drain = middleware.find(
          (registration) =>
            (registration as { name?: string }).name === "builtin:injection-queue-drain",
        ) as { fn: (context: unknown) => Promise<unknown> } | undefined;
        expect(drain).toBeDefined();
        const decision = await drain?.fn({
          pointId: "run.turn.post",
          timing: "turn.finish",
          runId: "run-1",
          sessionId: "session-1",
          traceContext: { traceId: "trace-1", runId: "run-1", sessionId: "session-1" },
        });
        expect(JSON.stringify(decision)).toContain("prompt.inject_message");
        expect(JSON.stringify(decision)).toContain("queued worker response");
        expect(queue.hasPending("run-1")).toBe(false);
        return {
          text: "done",
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      },
    });

    expect(result.response).toMatchObject({ status: "succeeded", output: "done" });
    registry.dispose();
    sanitizer.dispose();
  });

  test("sanitizes and bounds exact and encoded credentials in run responses and observations", async () => {
    const { sanitizer, registry } = pairedSanitizer();
    const result = await runWorker({
      sanitizer,
      queue: InjectionQueue.create(),
      async run() {
        const failure = new Error(`provider rejected ${secret} and ${encodedSecret}`, {
          cause: new Error(`cause:${secret}`),
        });
        failure.stack = `stack:${encodedSecret}`;
        throw failure;
      },
    });

    const egress = JSON.stringify(result);
    expect(result.response).toMatchObject({ status: "failed" });
    expect(egress).not.toContain(secret);
    expect(egress).not.toContain(encodedSecret);
    expect(egress).not.toContain("stack:");
    expect(egress).not.toContain("cause:");
    expect(egress).toContain("provider rejected [REDACTED] and [REDACTED]");
    const failureObservation = result.observations.find((entry) =>
      JSON.stringify(entry).includes("attempt.failed"),
    ) as { observation?: { data?: { reason?: string } } } | undefined;
    expect(failureObservation?.observation?.data?.reason?.length).toBeLessThanOrEqual(512);
    registry.dispose();
    sanitizer.dispose();
  });

  test("settles proxy timeouts as unknown with sanitized output and the production timeout", async () => {
    const { sanitizer, registry } = pairedSanitizer();
    const provider = createMcpProxyProvider(
      proxyOptions(sanitizer, async (method, _params, timeoutMs) => {
        expect(method).toBe("worker.tool_call");
        expect(timeoutMs).toBe(300_000);
        return Promise.reject(`timeout from ${secret} via ${encodedSecret}`);
      }),
    );
    const tool = provider.listTools()[0];
    if (!tool) throw new Error("missing proxy tool");

    const result = await tool.execute(toolCall());
    expect(result).toMatchObject({ isError: true, settlement: "unknown" });
    expect(result.output).toContain("timeout from [REDACTED] via [REDACTED]");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain(encodedSecret);
    expect(result.output.length).toBeLessThanOrEqual(512);
    registry.dispose();
    sanitizer.dispose();
  });

  test("sanitizes coordinator-provided proxy failure results before returning them", async () => {
    const { sanitizer, registry } = pairedSanitizer();
    const provider = createMcpProxyProvider(
      proxyOptions(sanitizer, async () => ({
        id: `result-${secret}`,
        toolCallId: `call-${encodedSecret}`,
        output: `remote failure ${secret} ${encodedSecret}`,
        isError: true,
        settlement: "settled",
      })),
    );
    const tool = provider.listTools()[0];
    if (!tool) throw new Error("missing proxy tool");

    const result = await tool.execute(toolCall());
    const egress = JSON.stringify(result);
    expect(result).toMatchObject({ isError: true, settlement: "settled" });
    expect(egress).not.toContain(secret);
    expect(egress).not.toContain(encodedSecret);
    expect(result.output).toContain("remote failure [REDACTED] [REDACTED]");
    registry.dispose();
    sanitizer.dispose();
  });
  test("aborting an in-flight proxy call triggers worker.tool_call_cancel", async () => {
    const { sanitizer, registry } = pairedSanitizer();
    const methods: string[] = [];
    const provider = createMcpProxyProvider(
      proxyOptions(sanitizer, async (method) => {
        methods.push(method);
        if (method === "worker.tool_call") return new Promise(() => undefined);
        return { cancelled: true };
      }),
    );
    const tool = provider.listTools()[0];
    if (!tool) throw new Error("missing proxy tool");
    const controller = new AbortController();

    const pending = tool.execute(toolCall(), { signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(methods).toEqual(["worker.tool_call", "worker.tool_call_cancel"]);
    expect(result).toMatchObject({
      output: "Tool call aborted",
      isError: true,
      settlement: "unknown",
    });
    registry.dispose();
    sanitizer.dispose();
  });
});
