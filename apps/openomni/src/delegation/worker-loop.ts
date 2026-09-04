import {
  createSessionChatRunner,
  session,
  type ChatAgentConfig,
  type SessionHandle,
  type SessionRunner,
  type SessionRunnerInput,
  type SessionRuntime,
} from "@openomni/agent";
import type { LedgerSession, Model } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/agent";
import { chatProviderConfig } from "../composition/chat-provider";
import { SessionBindingCache } from "../composition/session-bindings";
import { observeComponent } from "../observation/component";
import { buildAgentPrompt } from "../prompt/build";
import { WORKER_PRESET } from "../prompt/roles";
import { createTools } from "../tools/core/catalog";
import { createDispatcher, HOST_TARGET, sessionTool } from "@openomni/agent";
import { decideDrive, initialDriveState, type DriveState } from "./drive-loop";
import { renderInstruction } from "./instruction";
import type { InlineWorkerRunner } from "./inline-driver";
import type { DelegationKernel } from "./kernel";

export class WorkerRunError extends Error {
  constructor(
    message: string,
    readonly runId: string,
  ) {
    super(message);
    this.name = "WorkerRunError";
  }
}

export interface WorkerLoopOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  readonly llm?: ChatAgentConfig["llm"];
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

export function createInlineWorkerRunner(options: WorkerLoopOptions): SessionInlineWorkerRunner {
  const bindings = new SessionBindingCache<WorkerBinding>();
  const runtime = options.sessionRuntime ?? { observations: Bus };

  function createBinding(sessionId: string, parentId: string | null, depth: number): WorkerBinding {
    const definitions = createTools(
      { delegation: options.kernel() },
      { role: "worker", depth, sessionId },
    );
    const dispatcher = createDispatcher(definitions);
    const runner = createSessionChatRunner({
      prepare(input: SessionRunnerInput) {
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
            systemPrompt: input.system,
            tools,
            toolTargets: [HOST_TARGET],
            toolChoice: tools.length === 0 ? "none" : "auto",
            toolExecutor: (call, context) =>
              dispatcher.execute(call, {
                sessionId: input.sessionId,
                turnId: input.resultId,
                ...(context?.signal === undefined ? {} : { signal: context.signal }),
              }),
            model: options.model,
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
    let tokens = 0;
    let state: DriveState = initialDriveState();
    let prompt = renderInstruction(input.instruction, input.acceptanceCriteria);
    let lastRunId = input.workerRunId ?? input.delegationId;
    const interrupt = (): void => {
      // The abort signal is authoritative; a simultaneous lease loss or close
      // must not surface as an unhandled rejection from this best-effort doorbell.
      void binding.handle.interrupt().catch(() => undefined);
    };
    input.signal.addEventListener("abort", interrupt, { once: true });
    try {
      for (;;) {
        if (input.signal.aborted) throw new WorkerRunError("worker run aborted", lastRunId);
        const result = await binding.handle.prompt(prompt);
        const actionId = binding.handle.get().turns.at(-1)?.terminal?.actionId;
        if (actionId !== undefined) lastRunId = actionId;
        if (result === undefined) {
          throw new WorkerRunError("worker session produced no terminal result", lastRunId);
        }
        if (result.kind === "interrupted") {
          throw new WorkerRunError("worker run aborted", lastRunId);
        }
        if (result.kind === "error") {
          throw new WorkerRunError(result.cause?.message ?? result.text, lastRunId);
        }
        tokens += result.usage?.totalTokens ?? 0;
        if (input.operation !== "assign") {
          return { text: result.text, tokens, runId: lastRunId };
        }
        const decision = decideDrive(state, {
          text: result.text,
          finishReason: result.finishReason ?? "stop",
        });
        if (decision.action === "done") return { text: result.text, tokens, runId: lastRunId };
        if (decision.action === "stop") {
          return {
            text: `[drive stopped: ${decision.reason}]\n${result.text}`,
            tokens,
            runId: lastRunId,
          };
        }
        state = decision.state;
        prompt = decision.prompt;
      }
    } finally {
      input.signal.removeEventListener("abort", interrupt);
      await lease.release();
    }
  };

  return Object.assign(run, {
    runnerFor: (row: LedgerSession.Row) => createBinding(row.id, row.parentId, 1).runner,
  });
}
