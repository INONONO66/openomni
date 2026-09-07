import {
  createSessionChatRunner,
  createTurnDispatcher,
  failureFacts,
  HOST_TARGET,
  newTraceId,
  sessionTool,
  type ChatAgentConfig,
  type SessionRunner,
  type SessionRuntime,
} from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import type { Placement } from "@openomni/placement";
import type { AnyToolDefinition, LedgerSession, Model, Tool } from "@openomni/protocol";
import { chatProviderConfig } from "./composition/chat-provider";
import { messageMaterialization } from "./composition/message-session";
import { classifyTurnFailure } from "./observation/llm-failure";
import { observeComponent } from "./observation/component";
import { buildAgentPrompt } from "./prompt/build";
import { RESIDENT_PRESET, WORKER_PRESET } from "./prompt/roles";
import { createTools, type CatalogPorts } from "./tools/core/catalog";

function refuseEvidenceOnly(call: Tool.Call): Tool.Result {
  return {
    id: call.id,
    toolCallId: call.id,
    toolName: call.tool,
    output: "tool execution denied: evidence-only message",
    isError: true,
    settlement: "settled",
  };
}

export interface ResidentOptions {
  readonly model: Model.Ref;
  readonly modelFallbacks?: readonly Model.Ref[];
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  readonly llm?: ChatAgentConfig["llm"];
  readonly compaction?: ChatAgentConfig["compaction"];
  readonly tools: CatalogPorts;
  readonly toolDefinitions?: readonly AnyToolDefinition[];
  readonly targets?: () => readonly Placement.ToolTarget[];
  readonly sessionRuntime: SessionRuntime;
}

/** Resident and worker use the same session-owned runner and dispatcher. */
export function createResident(options: ResidentOptions) {
  const definitionsFor = (id: string, role: LedgerSession.Role) => [
    ...createTools(options.tools, { sessionId: id, role, depth: role === "resident" ? 0 : 1 }),
    ...(options.toolDefinitions ?? []),
  ];
  const runnerFor =
    (row: LedgerSession.Row): SessionRunner =>
    async (input) => {
      const definitions = definitionsFor(row.id, row.role);
      const dispatcher = createTurnDispatcher(definitions, input, options.sessionRuntime);
      const traceId = newTraceId();
      const observation = observeComponent({
        traceId,
        sessionId: input.sessionId,
        runId: input.resultId,
        actorId: row.role,
        agentName: row.role,
        componentId: `${row.role}.agent`,
        componentGeneration: input.resumeCount + 1,
        pluginName: `builtin.${row.role}`,
      });
      const evidenceOnly =
        input.messages
          .filter((message) => message.role === "user")
          .at(-1)
          ?.text.startsWith("[SYSTEM: the following is an OBSERVATION") === true;
      const offered = new Set(input.tools.map((tool) => tool.name));
      const tools = evidenceOnly ? [] : dispatcher.specs.filter((tool) => offered.has(tool.name));
      const runner = createSessionChatRunner({
        prepare: () => ({
          config: {
            events: observation.events,
            executor: dispatcher.executor,
            systemPrompt: input.system,
            tools,
            toolTargets: options.targets?.() ?? [HOST_TARGET],
            toolChoice: tools.length === 0 ? "none" : "auto",
            toolExecutor: (call, context) =>
              evidenceOnly
                ? Promise.resolve(refuseEvidenceOnly(call))
                : dispatcher.execute(call, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    ...(context?.signal === undefined ? {} : { signal: context.signal }),
                  }),
            toolWave: (calls, signal) =>
              evidenceOnly
                ? Promise.resolve(calls.map(refuseEvidenceOnly))
                : dispatcher.executeWave(calls, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    signal,
                  }),
            model: options.model,
            ...(options.modelFallbacks === undefined
              ? {}
              : { modelFallbacks: [...options.modelFallbacks] }),
            ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
            ...chatProviderConfig(options),
          },
          traceContext: {
            traceId,
            sessionId: input.sessionId,
            runId: input.resultId,
            agentName: row.role,
          },
          around: (operation) => observation.run(operation),
        }),
        reportError: (error) =>
          failureFacts(error)?.llm === true ? classifyTurnFailure(error).text : undefined,
      });
      options.tools.cells?.bindTools(row.id, definitions);
      try {
        const result = await runner(input);
        const origin = SessionHandleStore.inboxRows(row.id)
          .filter((item) => {
            const value = item.origin.value;
            return (
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.kind === "external"
            );
          })
          .at(-1)?.origin.value;
        if (
          (result.kind === "result" || (result.kind === "error" && result.reported)) &&
          origin !== null &&
          typeof origin === "object" &&
          !Array.isArray(origin) &&
          origin.kind === "external" &&
          typeof origin.actorId === "string"
        ) {
          await dispatcher.execute(
            {
              id: crypto.randomUUID(),
              tool: "sendMessage",
              input: {
                to: { kind: "actor", actorId: origin.actorId },
                type: "message",
                content: result.text,
              },
            },
            { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
          );
        }
        return result;
      } finally {
        options.tools.cells?.bindTools(row.id, []);
      }
    };
  return {
    runnerFor,
    materialize(id: string, parentId: string | null, role: LedgerSession.Role, runner: string) {
      if (!["resident", "worker", "native", "process"].includes(runner)) {
        throw new Error(`runner is not registered: ${runner}`);
      }
      return messageMaterialization({
        id,
        parentId,
        role,
        runner,
        tools: definitionsFor(id, role).map(sessionTool),
        preset: buildAgentPrompt(role === "resident" ? RESIDENT_PRESET : WORKER_PRESET),
        at: (options.sessionRuntime.clock ?? Date.now)(),
      });
    },
  };
}
