import {
  createSessionChatRunner,
  createTurnDispatcher,
  HOST_TARGET,
  session,
  sessionTool,
  type ChatAgentConfig,
  type SessionHandle,
  type SessionRunner,
  type SessionRunnerInput,
  type SessionRuntime,
  type SessionRunnerResult,
} from "@openomni/agent";
import type { LedgerSession, Model } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/agent";
import { chatProviderConfig } from "./chat-provider";
import { SessionBindingCache } from "./session-bindings";
import { observeComponent } from "../observation/component";
import { buildAgentPrompt } from "../prompt/build";
import { WORKER_PRESET } from "../prompt/roles";
import { seedKernelPolicyRows } from "../policy-seed";
import { createTools } from "../tools/core/catalog";
import { renderInstruction } from "../delegation/instruction";
import type { InlineWorkerRunner } from "../delegation/inline-driver";
import type { DelegationKernel } from "../delegation/kernel";

export function toolExecutorForTurn(
  dispatcher: Pick<ReturnType<typeof createTurnDispatcher>, "execute">,
  input: Pick<SessionRunnerInput, "sessionId" | "turnId">,
): NonNullable<ChatAgentConfig["toolExecutor"]> {
  return (call, context) =>
    dispatcher.execute(call, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    });
}

export class WorkerRunError extends Error {
  constructor(
    message: string,
    readonly runId: string,
  ) {
    super(message);
    this.name = "WorkerRunError";
  }
}

export interface WorkerSessionOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  readonly llm?: ChatAgentConfig["llm"];
  readonly compaction?: ChatAgentConfig["compaction"];
  readonly kernel: () => DelegationKernel;
  readonly sessionRuntime?: SessionRuntime;
}

export interface SessionInlineWorkerRunner extends InlineWorkerRunner {
  runnerFor(row: LedgerSession.Row): SessionRunner;
}

interface WorkerBinding {
  readonly handle: SessionHandle;
  readonly runner: SessionRunner;
  readonly release: () => void;
}

export function createWorkerSessionRunner(
  options: WorkerSessionOptions,
): SessionInlineWorkerRunner {
  seedKernelPolicyRows();
  const bindings = new SessionBindingCache<WorkerBinding>();
  const runtime = options.sessionRuntime ?? { observations: Bus };

  function createBinding(sessionId: string, parentId: string | null, depth: number): WorkerBinding {
    const definitions = createTools(
      { delegation: options.kernel() },
      { role: "worker", depth, sessionId },
    );
    const runner = createSessionChatRunner({
      prepare(input: SessionRunnerInput) {
        const dispatcher = createTurnDispatcher(definitions, input, runtime);
        const toolNames = new Set(input.tools.map((tool) => tool.name));
        const tools = dispatcher.specs.filter((tool) => toolNames.has(tool.name));
        const traceId = newTraceId();
        const runId = input.resultId;
        const observation = observeComponent({
          traceId,
          sessionId: input.sessionId,
          runId,
          actorId: "worker",
          agentName: "worker",
          componentId: "worker.agent",
          componentGeneration: input.resumeCount + 1,
          pluginName: "builtin.worker",
        });
        return {
          config: {
            events: observation.events,
            executor: dispatcher.executor,
            systemPrompt: input.system,
            tools,
            toolTargets: [HOST_TARGET],
            toolChoice: tools.length === 0 ? "none" : "auto",
            toolExecutor: toolExecutorForTurn(dispatcher, input),
            toolWave: (calls, signal) =>
              dispatcher.executeWave(calls, {
                sessionId: input.sessionId,
                turnId: input.turnId,
                signal,
              }),
            model: options.model,
            ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
            ...chatProviderConfig(options),
          },
          traceContext: { traceId, sessionId: input.sessionId, runId, agentName: "worker" },
          around: (operation) => observation.run(operation),
        };
      },
    });
    const handle = session(
      {
        id: sessionId,
        parentId,
        role: "worker",
        runner,
        tools: definitions.map(sessionTool),
        system: { preset: buildAgentPrompt(WORKER_PRESET), blocks: [] },
      },
      runtime,
    );
    return { handle, runner, release: () => undefined };
  }

  const run: InlineWorkerRunner = async (input) => {
    const lease = await bindings.acquire(input.delegationId, () =>
      createBinding(input.delegationId, input.origin.sessionId, input.origin.depth),
    );
    const { binding } = lease;
    const prompt = renderInstruction(input.instruction, input.acceptanceCriteria);
    let lastRunId = input.workerRunId ?? input.delegationId;
    const interrupt = (): void => {
      // The abort signal is authoritative; a simultaneous lease loss or close
      // must not surface as an unhandled rejection from this best-effort doorbell.
      void binding.handle.interrupt().catch(() => undefined);
    };
    input.signal.addEventListener("abort", interrupt, { once: true });
    try {
      input.signal.throwIfAborted();
      let result = await binding.handle.prompt(prompt);
      if (result?.kind === "waiting") result = await awaitWorkerWake(binding.handle, input.signal);
      const actionId = binding.handle.get().turns.at(-1)?.terminal?.actionId;
      if (actionId !== undefined) lastRunId = actionId;
      if (result === undefined)
        throw new WorkerRunError("worker session produced no terminal result", lastRunId);
      if (result.kind === "interrupted") throw new WorkerRunError("worker run aborted", lastRunId);
      if (result.kind === "error")
        throw new WorkerRunError(result.cause?.message ?? result.text, lastRunId);
      if (result.kind === "waiting") throw new Error("worker wake returned a waiting result");
      return { text: result.text, tokens: result.usage?.totalTokens ?? 0, runId: lastRunId };
    } finally {
      input.signal.removeEventListener("abort", interrupt);
      await lease.release();
    }
  };

  return Object.assign(run, {
    runnerFor: (row: LedgerSession.Row) => createBinding(row.id, row.parentId, 1).runner,
  });
}

/** Transport waits for a future session terminal; it never invokes another agent loop. */
function awaitWorkerWake(handle: SessionHandle, signal: AbortSignal): Promise<SessionRunnerResult> {
  const watch = handle.watch();
  return new Promise((resolve, reject) => {
    const release = () => {
      unsubscribe();
      watch.unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      release();
      reject(new DOMException("worker aborted", "AbortError"));
    };
    const inspect = () => {
      const turn = handle.get().turns.at(-1);
      if (turn?.terminal === undefined || turn.terminal.kind === "waiting") return;
      const kind = turn.terminal.kind;
      const text =
        turn.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
      release();
      resolve(
        kind === "result" ? { kind, text } : kind === "error" ? { kind, text } : { kind, text },
      );
    };
    const unsubscribe = watch.subscribe(inspect);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else inspect();
  });
}
